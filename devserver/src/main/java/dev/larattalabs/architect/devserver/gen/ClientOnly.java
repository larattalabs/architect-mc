package dev.larattalabs.architect.devserver.gen;

import java.util.concurrent.CompletableFuture;

/** What renders on the client has no headless answer: these fail with a message that names the hook as client-only. */
final class ClientOnly {
	private ClientOnly() {
	}

	static final String WHY = "client-only: this hook renders on a client; the headless server has none (run the step with host client)";

	static <T> CompletableFuture<T> deltaGhost(String key, String siteId, int toVersion) {
		return CompletableFuture.failedFuture(new DevBridge.DevException(WHY));
	}
}
