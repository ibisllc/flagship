/**
 * A one-file ustar archive, for fakes that stand in for an app's files folder dump: the restore
 * path checks every files tar (serverArchive/tarCheck.ts) before anything unpacks it.
 */
export function miniTar(text: string, name = "data.txt"): Buffer {
  const data = Buffer.from(text, "utf8");
  const h = Buffer.alloc(512);
  h.write(name, 0, "latin1");
  h.write("0000644\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write("0", 156, "latin1");
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad, Buffer.alloc(1024)]);
}

/** The one file's text back out of `miniTar`. */
export function miniTarText(tar: Buffer): string {
  const size = Number.parseInt(tar.subarray(124, 135).toString("latin1"), 8);
  return tar.subarray(512, 512 + size).toString("utf8");
}
