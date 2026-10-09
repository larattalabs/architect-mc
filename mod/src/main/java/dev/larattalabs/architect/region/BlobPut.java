package dev.larattalabs.architect.region;

import java.util.concurrent.CompletableFuture;

/** Blob put/read through the client's sidecar link ({@code apiimpl.RegionBridge}). */
final class BlobPut {
	private BlobPut() {
	}

	static CompletableFuture<String> put(TileStream.Link link, byte[] data, String kind) {
		return dev.larattalabs.architect.apiimpl.RegionBridge.put(data, kind);
	}

	static CompletableFuture<byte[]> read(String blobId) {
		return dev.larattalabs.architect.apiimpl.RegionBridge.read(blobId);
	}
}
