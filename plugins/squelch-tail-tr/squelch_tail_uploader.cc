#include <curl/curl.h>
#include <boost/dll/alias.hpp>
#include <boost/foreach.hpp>
#include <boost/regex.hpp>
#include <sys/stat.h>
#include <string>
#include <vector>

#include "../../trunk-recorder/call_concluder/call_concluder.h"
#include "../../trunk-recorder/plugin_manager/plugin_api.h"

/**
 * squelch_tail_uploader — trunk-recorder plugin for squelch-tail.
 *
 * Uploads each completed call to a squelch-tail instance via multipart POST.
 * Sends two parts:
 *   key     — API key (text field)
 *   system  — numeric system ID (text field)
 *   audio   — the audio file (binary)
 *   meta    — the complete trunk-recorder JSON metadata (text, from call_json)
 *
 * trunk-recorder config.json:
 * {
 *   "plugins": [{
 *     "name":    "squelch_tail_uploader",
 *     "library": "libsquelch_tail_uploader",
 *     "server":  "http://192.168.1.10:3000",
 *     "systems": [{
 *       "shortName": "county",
 *       "apiKey":    "changeme",
 *       "systemId":  1
 *     }]
 *   }]
 * }
 */

struct Squelch_Tail_System {
    std::string api_key;
    std::string short_name;
    uint32_t    system_id;
};

struct Squelch_Tail_Data {
    std::vector<Squelch_Tail_System> systems;
    std::string server;
};

boost::mutex rs_curl_mutex;

class Squelch_Tail_Uploader : public Plugin_Api {
    Squelch_Tail_Data data;
    CURLSH           *curl_share;
    std::string       plugin_name;

public:
    Squelch_Tail_Uploader() : curl_share(nullptr) {}

    // ── Plugin_Api interface ──────────────────────────────────────────────────

    int call_end(Call_Data_t call_info) {
        return upload(call_info);
    }

    int parse_config(json config_data) {
        plugin_name = config_data.value("name", "squelch_tail_uploader");

        if (!config_data.contains("server")) {
            BOOST_LOG_TRIVIAL(error) << "[squelch-tail] Missing \"server\" in plugin config";
            return 1;
        }
        data.server = config_data.value("server", "");
        BOOST_LOG_TRIVIAL(info) << "[squelch-tail] Server: " << data.server;

        if (!config_data.contains("systems") || !config_data["systems"].is_array()) {
            BOOST_LOG_TRIVIAL(error) << "[squelch-tail] Missing \"systems\" array in plugin config";
            return 1;
        }

        for (const auto &elem : config_data["systems"]) {
            if (!elem.contains("apiKey")) continue;
            Squelch_Tail_System sys;
            sys.api_key   = elem.value("apiKey",    "");
            sys.system_id = elem.value("systemId",  0);
            sys.short_name= elem.value("shortName", "");
            data.systems.push_back(sys);
            BOOST_LOG_TRIVIAL(info) << "[squelch-tail] Uploading system: " << sys.short_name
                                    << "  systemId=" << sys.system_id;
        }

        if (data.systems.empty()) {
            BOOST_LOG_TRIVIAL(error) << "[squelch-tail] No systems configured";
            return 1;
        }

        // Shared DNS cache across uploads
        curl_share = curl_share_init();
        curl_share_setopt(curl_share, CURLSHOPT_SHARE,      CURL_LOCK_DATA_DNS);
        curl_share_setopt(curl_share, CURLSHOPT_LOCKFUNC,   curl_lock_cb);
        curl_share_setopt(curl_share, CURLSHOPT_UNLOCKFUNC, curl_unlock_cb);

        return 0;
    }

    static boost::shared_ptr<Squelch_Tail_Uploader> create() {
        return boost::shared_ptr<Squelch_Tail_Uploader>(new Squelch_Tail_Uploader());
    }

private:

    Squelch_Tail_System *get_system(const std::string &short_name) {
        for (auto &sys : data.systems) {
            if (sys.short_name == short_name) return &sys;
        }
        return nullptr;
    }

    int upload(Call_Data_t &call_info) {
        Squelch_Tail_System *sys = get_system(call_info.short_name);
        if (!sys || sys->api_key.empty()) return 0;

        // Skip encrypted calls — no audio to serve
        if (call_info.encrypted) return 0;

        // Choose audio file: prefer compressed (m4a) if available
        const std::string &audio_path = call_info.compress_wav && !call_info.converted.empty()
            ? call_info.converted
            : call_info.filename;

        if (audio_path.empty()) {
            BOOST_LOG_TRIVIAL(warning) << "[squelch-tail] No audio file for call, skipping";
            return 0;
        }

        // Serialise the TR metadata JSON that was already built by call_concluder
        const std::string meta_json = call_info.call_json.dump();

        const std::string url        = data.server + "/api/call-upload";
        const std::string system_id  = std::to_string(sys->system_id);
        const std::string audio_name = boost::filesystem::path(audio_path).filename().string();

        std::string response_buffer;
        char        curl_errbuf[CURL_ERROR_SIZE] = {};

        CURL     *curl  = curl_easy_init();
        if (!curl) {
            BOOST_LOG_TRIVIAL(error) << "[squelch-tail] curl_easy_init() failed";
            return 1;
        }

        curl_mime     *mime = curl_mime_init(curl);
        curl_mimepart *part;

        // ── key ───────────────────────────────────────────────────────────────
        part = curl_mime_addpart(mime);
        curl_mime_name(part, "key");
        curl_mime_data(part, sys->api_key.c_str(), CURL_ZERO_TERMINATED);

        // ── system ────────────────────────────────────────────────────────────
        part = curl_mime_addpart(mime);
        curl_mime_name(part, "system");
        curl_mime_data(part, system_id.c_str(), CURL_ZERO_TERMINATED);

        // ── audio (binary file) ───────────────────────────────────────────────
        part = curl_mime_addpart(mime);
        curl_mime_name(part, "audio");
        curl_mime_filedata(part, audio_path.c_str());
        curl_mime_filename(part, audio_name.c_str());
        curl_mime_type(part, "audio/mp4");

        // ── meta (JSON string) ────────────────────────────────────────────────
        part = curl_mime_addpart(mime);
        curl_mime_name(part, "meta");
        curl_mime_data(part, meta_json.c_str(), meta_json.size());
        curl_mime_filename(part, (audio_name.substr(0, audio_name.rfind('.')) + ".json").c_str());
        curl_mime_type(part, "application/json");

        // ── curl options ──────────────────────────────────────────────────────
        curl_slist *headers = curl_slist_append(nullptr, "Expect:");

        curl_easy_setopt(curl, CURLOPT_URL,              url.c_str());
        curl_easy_setopt(curl, CURLOPT_MIMEPOST,         mime);
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER,       headers);
        curl_easy_setopt(curl, CURLOPT_USERAGENT,        "TrunkRecorder/squelch-tail-uploader");
        curl_easy_setopt(curl, CURLOPT_ERRORBUFFER,      curl_errbuf);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL,         1L);
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 15000L);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS,       120000L);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,    write_cb);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA,        &response_buffer);

        if (curl_share) {
            curl_easy_setopt(curl, CURLOPT_SHARE,            curl_share);
            curl_easy_setopt(curl, CURLOPT_DNS_CACHE_TIMEOUT, 300L);
        }

        // ── perform ───────────────────────────────────────────────────────────
        CURLcode  easy_res = curl_easy_perform(curl);
        long      http_code = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

        curl_easy_cleanup(curl);
        curl_mime_free(mime);
        curl_slist_free_all(headers);

        // ── log result ────────────────────────────────────────────────────────
        const std::string loghdr = log_header(call_info.short_name, call_info.call_num,
                                              call_info.talkgroup_display, call_info.freq);
        if (easy_res != CURLE_OK) {
            BOOST_LOG_TRIVIAL(error) << loghdr << "[squelch-tail] Upload failed: "
                                     << curl_easy_strerror(easy_res)
                                     << (curl_errbuf[0] ? std::string(" (") + curl_errbuf + ")" : "");
            return 1;
        }

        if (http_code >= 200 && http_code < 300) {
            struct stat st{};
            stat(audio_path.c_str(), &st);
            BOOST_LOG_TRIVIAL(info) << loghdr << "[squelch-tail] Upload OK (HTTP " << http_code
                                    << ")  size=" << st.st_size << "B";
            return 0;
        }

        BOOST_LOG_TRIVIAL(error) << loghdr << "[squelch-tail] Upload error HTTP " << http_code
                                 << ": " << response_buffer;
        return 1;
    }

    static size_t write_cb(void *ptr, size_t size, size_t nmemb, void *userp) {
        static_cast<std::string *>(userp)->append(static_cast<char *>(ptr), size * nmemb);
        return size * nmemb;
    }

    static void curl_lock_cb(CURL *, curl_lock_data, curl_lock_access, void *) {
        rs_curl_mutex.lock();
    }
    static void curl_unlock_cb(CURL *, curl_lock_data, curl_lock_access, void *) {
        rs_curl_mutex.unlock();
    }
};

BOOST_DLL_ALIAS(Squelch_Tail_Uploader::create, create_plugin)
