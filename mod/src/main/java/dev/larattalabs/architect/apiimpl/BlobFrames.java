package dev.larattalabs.architect.apiimpl;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * How a blob goes over the link (docs/CONTRACT.md "Jobs (R2)": {@code blob.put}; "Phase 4a sidecar as built": frames of at
 * most 16 MB, {@code more: true} for multi-frame uploads). A binary blob is cut into chunks of at most 1 MB (decoded), and
 * the chunks into frames whose base64 stays well under a frame. Pure. Internal.
 */
public final class BlobFrames {
	/** One chunk, decoded (the sidecar's MAX_CHUNK_BYTES). */
	public static final int CHUNK_BYTES = 1024 * 1024;
	/** One WebSocket frame (the sidecar closes above 16 MB). */
	public static final int FRAME_BYTES = 16 * 1024 * 1024;
	/** A blob in all (the sidecar's MAX_BLOB_BYTES). */
	public static final int MAX_BLOB_BYTES = 64 * 1024 * 1024;
	/** The base64 we put in one frame: room for the envelope, under any frame limit. */
	public static final int FRAME_BUDGET = 12 * 1024 * 1024;
	/** A JSON blob up to this size goes whole ({@code data}); a bigger one as UTF-8 chunks. */
	public static final int JSON_WHOLE_MAX = FRAME_BUDGET;

	private BlobFrames() {
	}

	/** The base64 length of {@code n} bytes. */
	public static long base64Length(long n) {
		return (n + 2) / 3 * 4;
	}

	/**
	 * The frames of a binary blob: each a list of base64 chunks of at most {@code chunkBytes} decoded bytes, with at most
	 * {@code frameBudget} base64 characters per frame (at least one chunk per frame). An empty blob is one frame with no
	 * chunks.
	 */
	public static List<List<String>> frames(byte[] data, int chunkBytes, int frameBudget) {
		if (chunkBytes <= 0) {
			throw new IllegalArgumentException("chunkBytes " + chunkBytes);
		}
		List<List<String>> out = new ArrayList<>();
		List<String> frame = new ArrayList<>();
		long frameChars = 0;
		Base64.Encoder enc = Base64.getEncoder();
		for (int off = 0; off < data.length; off += chunkBytes) {
			int len = Math.min(chunkBytes, data.length - off);
			long chars = base64Length(len);
			if (!frame.isEmpty() && (frameChars + chars > frameBudget || frame.size() >= 64)) {
				out.add(frame);
				frame = new ArrayList<>();
				frameChars = 0;
			}
			byte[] chunk = new byte[len];
			System.arraycopy(data, off, chunk, 0, len);
			frame.add(enc.encodeToString(chunk));
			frameChars += chars;
		}
		out.add(frame);
		return out;
	}

	/** {@link #frames(byte[], int, int)} with the protocol's sizes. */
	public static List<List<String>> frames(byte[] data) {
		return frames(data, CHUNK_BYTES, FRAME_BUDGET);
	}
}
