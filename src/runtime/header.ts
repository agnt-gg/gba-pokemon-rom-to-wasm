/** GBA cartridge header parser (entrypoint, title, game code, checks). */
export interface GbaHeader {
  entryOpcode: number; // ARM branch at 0x00
  title: string;       // 0xA0..0xAB
  gameCode: string;    // 0xAC..0xAF (e.g. AXVE Ruby, AXPE Sapphire, BPEE Emerald)
  makerCode: string;   // 0xB0..0xB1
  fixedByte: number;   // 0xB2 must be 0x96
  headerChecksumOk: boolean;
}

export function parseHeader(rom: Uint8Array): GbaHeader {
  const ascii = (a: number, b: number) => {
    let s = ''; for (let i = a; i <= b; i++) { const c = rom[i]; if (c === 0) break; s += String.fromCharCode(c); }
    return s;
  };
  const entryOpcode = (rom[0] | (rom[1] << 8) | (rom[2] << 16) | (rom[3] << 24)) >>> 0;
  // Header checksum at 0xBD over 0xA0..0xBC.
  let chk = 0; for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - rom[i]) & 0xff; chk = (chk - 0x19) & 0xff;
  return {
    entryOpcode,
    title: ascii(0xa0, 0xab),
    gameCode: ascii(0xac, 0xaf),
    makerCode: ascii(0xb0, 0xb1),
    fixedByte: rom[0xb2],
    headerChecksumOk: chk === rom[0xbd],
  };
}
