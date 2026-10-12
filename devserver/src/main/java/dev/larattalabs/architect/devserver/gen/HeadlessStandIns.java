package dev.larattalabs.architect.devserver.gen;

/** The client classes RegionDev6b reaches, as headless stand-ins of the same simple names (devserver/build.gradle genHooks). */
final class HeadlessStandIns {
	private HeadlessStandIns() {
	}
}

/** The region ghost renders on a client: headless, showing it is refused and the state says so. */
final class RegionGhost {
	private RegionGhost() {
	}

	static java.util.concurrent.CompletableFuture<dev.larattalabs.architect.region.GhostPlan> show(String planId, String stage) {
		return java.util.concurrent.CompletableFuture.failedFuture(new DevBridge.DevException(ClientOnly.WHY + " (the region ghost)"));
	}

	static void hide() {
	}

	static com.google.gson.JsonObject state() {
		com.google.gson.JsonObject o = new com.google.gson.JsonObject();
		o.addProperty("on", false);
		o.addProperty("headless", true);
		return o;
	}
}

/** The client's Sidecar facade, on the devserver's link. */
final class Sidecar {
	private Sidecar() {
	}

	static java.nio.file.Path dataDir() {
		return dev.larattalabs.architect.devserver.ServerSidecar.dataDirPublic();
	}

	static dev.larattalabs.architect.client.sidecar.SidecarLink link() {
		return dev.larattalabs.architect.devserver.ServerSidecar.linkPublic();
	}
}

/** DevCommands.camera, headless: the bot moves there (CoreHooks.camera). */
final class DevCommands {
	private DevCommands() {
	}

	static java.util.concurrent.CompletableFuture<com.google.gson.JsonObject> camera(com.google.gson.JsonObject req, Mc mc) {
		return CoreHooks.camera(req);
	}
}
