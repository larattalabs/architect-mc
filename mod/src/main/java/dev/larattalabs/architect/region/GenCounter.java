package dev.larattalabs.architect.region;

import dev.larattalabs.architect.site.Sites;
import java.util.List;
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
	/** Chunks loaded (generated or from disk) this session (gate S9: chunks loaded per stage). */
	private static final AtomicLong LOADS = new AtomicLong();
	/** Chunks generated while a region item held tickets (checked by the gate: must stay 0 under GENERATED_ONLY). */
	private static final AtomicLong WHILE_HELD = new AtomicLong();
	private static volatile int holders;
	private static final boolean TRACE = System.getenv("ARCHITECT_TRACE_JOBS") != null;
	/** Whether a region is realising now (the server thread sets it every tick; the mixin reads it). */
	private static volatile boolean realising;
	/** Chunks whose terrain was generated while a region realised, for the server thread to attribute and log (bounded). */
	private static final java.util.concurrent.ConcurrentLinkedQueue<Gen> PENDING = new java.util.concurrent.ConcurrentLinkedQueue<>();

	/** A chunk whose terrain was generated while a region realised: its dimension and position ({@code ChunkPos.pack}). */
	public record Gen(String dimension, long chunk) {
	}
	private static final java.util.concurrent.atomic.AtomicInteger PENDING_N = new java.util.concurrent.atomic.AtomicInteger();
	private static final AtomicLong DROPPED = new AtomicLong();

	private GenCounter() {
	}

	public static void init() {
		ServerChunkEvents.CHUNK_LOAD.register((level, chunk, generated) -> {
			LOADS.incrementAndGet();
			if (generated) {
				long n = FULL.incrementAndGet();
				if (TRACE && n <= 300) {
					dev.larattalabs.architect.Architect.LOGGER.info("TRACE generated FULL chunk {} (holders {})", chunk.getPos(), holders);
				}
			}
			ChunkGen.generated(Sites.dimensionId(level), chunk.getPos().pack());
		});
	}

	/** Worker threads (the mixin). */
	public static void terrain(ServerLevel level, long chunk) {
		long n = TERRAIN.incrementAndGet();
		if (TRACE && n <= 300) {
			dev.larattalabs.architect.Architect.LOGGER.info("TRACE generated terrain {},{} (holders {})", net.minecraft.world.level.ChunkPos.getX(chunk),
				net.minecraft.world.level.ChunkPos.getZ(chunk), holders);
		}
		if (holders > 0) {
			WHILE_HELD.incrementAndGet();
		}
		if (realising) {
			if (PENDING_N.incrementAndGet() <= 20_000) {
				PENDING.add(new Gen(Sites.dimensionId(level), chunk));
			} else {
				PENDING_N.decrementAndGet();
				DROPPED.incrementAndGet(); // counted by the server thread as generated, not attributed
			}
		}
	}

	/** Server thread, every tick: whether a region realises now. */
	public static void realising(boolean on) {
		realising = on;
	}

	/** Server thread: the chunks generated during a realise since the last call (with their dimension). */
	public static List<Gen> drain() {
		List<Gen> out = new java.util.ArrayList<>();
		Gen c;
		while ((c = PENDING.poll()) != null) {
			PENDING_N.decrementAndGet();
			out.add(c);
		}
		return out;
	}

	/** Server thread: how many chunks generated during a realise were not queued since the last call (overflow: not attributed). */
	public static long dropped() {
		return DROPPED.getAndSet(0);
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

	public static long loads() {
		return LOADS.get();
	}

	public static long whileHeld() {
		return WHILE_HELD.get();
	}

	public static void reset() {
		TERRAIN.set(0);
		FULL.set(0);
		LOADS.set(0);
		WHILE_HELD.set(0);
		holders = 0;
	}
}
