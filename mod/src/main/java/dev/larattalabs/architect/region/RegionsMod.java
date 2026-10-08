package dev.larattalabs.architect.region;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

/** Phase 6a wiring: the generation counters and the chunk-status cache, reset with the world. */
public final class RegionsMod {
	private RegionsMod() {
	}

	public static void init() {
		GenCounter.init();
		ServerLifecycleEvents.SERVER_STARTING.register(s -> {
			ChunkGen.reset();
			GenCounter.reset();
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> ChunkGen.reset());
	}
}
