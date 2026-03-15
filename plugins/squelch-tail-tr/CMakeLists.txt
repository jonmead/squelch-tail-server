add_library(squelch_tail_uploader
  MODULE
    squelch_tail_uploader.cc
)

target_link_libraries(squelch_tail_uploader
  trunk_recorder_library
  ssl crypto
  ${CURL_LIBRARIES}
  ${Boost_LIBRARIES}
  ${GNURADIO_PMT_LIBRARIES}
  ${GNURADIO_RUNTIME_LIBRARIES}
  ${GNURADIO_FILTER_LIBRARIES}
  ${GNURADIO_DIGITAL_LIBRARIES}
  ${GNURADIO_ANALOG_LIBRARIES}
  ${GNURADIO_AUDIO_LIBRARIES}
  ${GNURADIO_BLOCKS_LIBRARIES}
  ${GNURADIO_OSMOSDR_LIBRARIES}
  ${LIBOP25_REPEATER_LIBRARIES}
  gnuradio-op25_repeater
)

if(NOT Gnuradio_VERSION VERSION_LESS "3.8")
  target_link_libraries(squelch_tail_uploader
    gnuradio::gnuradio-analog
    gnuradio::gnuradio-blocks
    gnuradio::gnuradio-digital
    gnuradio::gnuradio-filter
    gnuradio::gnuradio-pmt
  )
endif()

install(TARGETS squelch_tail_uploader
  LIBRARY DESTINATION ${CMAKE_INSTALL_PREFIX}/lib/trunk-recorder
)
