'use strict';

/**
 * Prints the Squelch Tail startup banner to stdout.
 *
 * Visual design mirrors the SVG logo:
 *   · 11 active waveform bars (bright amber), symmetric above/below centre
 *   · 12 tail bars fading right (amber → brown → dim)
 *   · "SQUELCH" in bright white, "TAIL" in amber, flush right of the waveform
 *
 * Bar heights (index 0-10): [1,2,2,3,3,2,2,3,2,2,1]
 * Tail heights (index 0-11): [2,1,2,1,1,1,0,1,0,0,0,0]
 *
 * Each bar is 2 chars wide; no separator → 22 chars active, 24 chars tail.
 * Centre row (row 3 of 5) shows all bars.
 */
function printBanner(port) {
    const A  = '\x1b[38;5;220m'; // bright amber  — active waveform
    const A2 = '\x1b[38;5;178m'; // near tail
    const T1 = '\x1b[38;5;136m'; // mid tail
    const T2 = '\x1b[38;5;94m';  // far tail
    const T3 = '\x1b[38;5;58m';  // fading tail
    const W  = '\x1b[97m';       // bright white  — SQUELCH wordmark
    const DG = '\x1b[2;37m';     // dim gray      — server info lines
    const R  = '\x1b[0m';        // reset

    // ── Active waveform rows (22 chars each) ────────────────────────────────
    // Row 1 / 5  h=3 bars only  (indices 3, 4, 7)
    const r1 = '      ████    ██      ';
    // Row 2 / 4  h≥2 bars       (indices 1-9)
    const r2 = '  ██████████████████  ';
    // Row 3      all bars        (indices 0-10)
    const r3 = '██████████████████████';

    // ── Tail rows (24 chars each) ────────────────────────────────────────────
    // Row 2 / 4  h≥2 tail bars  (indices 0, 2)
    //   t0=██  t1=·· t2=██  t3-11=··
    const t24 = `${A2}██  ${T1}██                  `;   // 2+2+2+18 = 24

    // Row 3      h≥1 tail bars  (indices 0,1,2,3,4,5,·,7)
    //   t0-1=A2  t2-3=T1  t4-5=T2  t6=··  t7=T3  t8-11=··
    const t3  = `${A2}████${T1}████${T2}████  ${T3}██        `; // 4+4+6+2+8 = 24

    console.log('');
    console.log(`  ${A}${r1}                        ${R}`);
    console.log(`  ${A}${r2}${t24}${R}    ${W}SQUELCH${R}`);
    console.log(`  ${A}${r3}${t3}${R}    ${A}TAIL${R}`);
    console.log(`  ${A}${r2}${t24}${R}`);
    console.log(`  ${A}${r1}${R}`);
    console.log('');
    console.log(`  ${DG}port     :${port}${R}`);
    console.log(`  ${DG}ws       ws://localhost:${port}/ws${R}`);
    console.log(`  ${DG}upload   POST /api/call-upload${R}`);
    console.log('');
}
module.exports = { printBanner };
