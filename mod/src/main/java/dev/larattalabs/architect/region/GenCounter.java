package dev.larattalabs.architect.region;

import dev.larattalabs.architect.site.Sites;
import java.util.concurrent.atomic.AtomicLong;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerChunkEvents;
import net.minecraft.server.level.ServerLevel;

/**
 * Chunks generated in this world session (phase 6a, DevBridge {@code dev.chunks.generated}): {@link #terrain} counts chunks
 * whose terrain was generated (any status, the gate's "0 generated during realise" counter), {@link #full} chunks that
 * reached FULL by generation. Region items record the terrain count at their start and end ({@code generatedWhileHeld}).
 */
public final class GenCounter {
	private static final AtomicLong TERRAIN = new AtomicLong();
	private static final AtomicLong FULL = new AtomicLong();
	/** Chunks generated while a region item held tickets (checked by the gate: must stay 0 under GENERATED_ONLY). */
	private static final AtomicLong WHILE_HELD = new AtomicLong();
	private static volatile int holders;

	private GenCounter() {
	}

	public static void init() {
		ServerChunkEvents.CHUNK_LOAD.register((level, chunk, generated) -> {
			if (generated) {
				FULL.incrementAndGet();
			}
			ChunkGen.generated(Sites.dimensionId(level), chunk.getPos().pack());
		});
	}

	/** Worker threads (the mixin). */
	public static void terrain(ServerLevel level, long chunk) {
		TERRAIN.incrementAndGet();
		if (holders > 0) {
			WHILE_HELD.incrementAndGet();
		}
	}

	/** Region items holding tickets now (server thread sets it every tick). */
	public static void holders(int n) {
		holders = n;
	}

	public static long terrain() {
		return TERRAIN.get();
	}

	public static long full() {
		return FULL.get();
	}

	public static long whileHeld() {
		return WHILE_HELD.get();
	}

	public static void reset() {
		TERRAIN.set(0);
		FULL.set(0);
		WHILE_HELD.set(0);
		holders = 0;
	}
}
