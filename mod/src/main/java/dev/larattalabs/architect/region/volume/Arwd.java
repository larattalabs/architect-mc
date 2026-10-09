package dev.larattalabs.architect.region.volume;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * ARWD, the realised-world dump (kit/REGIONS.md "Realised-world dumps", the scenario metrics), little-endian:
 * <pre>
 * "ARWD" u8 version=1 u8 flags (bit 0: light present) u8 0 0
 * i32 minX, minY, minZ, maxX, maxY, maxZ
 * varint paletteSize, then per entry: varint byteLength + UTF-8 canonical block state (as ARTL)
 * columns, x-major: runs bottom-up (varint paletteIndex, varint length)
 * if light: columns, x-major: runs bottom-up (u8 blockLight, varint length)
 * </pre>
 * The file is the gzip of these bytes. Pure.
 */
public final class Arwd {
	private Arwd() {
	}

	/**
	 * Encodes a dump: {@code cells[((x * d) + z) * h + y]} palette indices (box-relative), {@code light} the same layout or null.
	 */
	public static byte[] encode(int[] box, List<String> palette, int[] cells, byte @org.jspecify.annotations.Nullable [] light) {
		int w = box[3] - box[0] + 1;
		int d = box[5] - box[2] + 1;
		int h = box[4] - box[1] + 1;
		Arvx.Out out = new Arvx.Out(1 << 16);
		out.bytes("ARWD".getBytes(StandardCharsets.US_ASCII));
		out.u8(1);
		out.u8(light != null ? 1 : 0);
		out.u8(0);
		out.u8(0);
		for (int v : box) {
			out.i32(v);
		}
		out.varint(palette.size());
		for (String s : palette) {
			byte[] b = s.getBytes(StandardCharsets.UTF_8);
			out.varint(b.length);
			out.bytes(b);
		}
		for (int c = 0; c < w * d; c++) {
			int base = c * h;
			int y = 0;
			while (y < h) {
				int v = cells[base + y];
				int j = y + 1;
				while (j < h && cells[base + j] == v) {
					j++;
				}
				out.varint(v);
				out.varint(j - y);
				y = j;
			}
		}
		if (light != null) {
			for (int c = 0; c < w * d; c++) {
				int base = c * h;
				int y = 0;
				while (y < h) {
					byte v = light[base + y];
					int j = y + 1;
					while (j < h && light[base + j] == v) {
						j++;
					}
					out.u8(v & 0xFF);
					out.varint(j - y);
					y = j;
				}
			}
		}
		return out.result();
	}
}
