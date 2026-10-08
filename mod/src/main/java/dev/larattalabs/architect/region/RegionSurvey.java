package dev.larattalabs.architect.region;

import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.site.Sites;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.TicketType;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.LevelChunk;

/**
 * A region's plan survey ({@link Columns}, resolution 1 or 4), sliced on the server thread like 4a's survey: {@code LOADED_ONLY}
 * reads loaded chunks only; {@code GENERATED_ONLY(n)} also loads generated chunks from disk (never generating), and
 * {@code LOAD_BOUNDED(n)} loads or generates at most {@code n}, both by short-lived tickets, at most 32 at once. Unread
 * columns are missing.
 */
final class RegionSurvey {
	static final long BUDGET_NANOS = 3_000_000L;
	static final int IN_FLIGHT = 32;
	static final TicketType TICKET = net.minecraft.core.Registry.register(net.minecraft.core.registries.BuiltInRegistries.TICKET_TYPE,
		dev.larattalabs.architect.Architect.id("region_survey"), new TicketType(0L, TicketType.FLAG_LOADING));

	private static final class Task {
		final ServerLevel level;
		final Columns cols;
		final List<Long> chunks;
		final LoadPolicy load;
		final CompletableFuture<Columns> future = new CompletableFuture<>();
		final Set<Long> ticketed = new LinkedHashSet<>();
		int next;
		int loaded;
		final Set<Long> done = new java.util.HashSet<>();

		Task(ServerLevel level, Columns cols, List<Long> chunks, LoadPolicy load) {
			this.level = level;
			this.cols = cols;
			this.chunks = chunks;
			this.load = load;
		}
	}

	private static final List<Task> TASKS = new ArrayList<>();

	private RegionSurvey() {
	}

	static CompletableFuture<Columns> sample(ServerLevel level, int x0, int z0, int x1, int z1, int res, LoadPolicy load) {
		int w = (x1 - x0) / res + 1;
		int d = (z1 - z0) / res + 1;
		Columns c = new Columns(x0, z0, w, d, res);
		List<Long> chunks = new ArrayList<>();
		for (int cx = x0 >> 4; cx <= x1 >> 4; cx++) {
			for (int cz = z0 >> 4; cz <= z1 >> 4; cz++) {
				chunks.add(ChunkPos.pack(cx, cz));
			}
		}
		Task t = new Task(level, c, chunks, load == null ? LoadPolicy.LOADED_ONLY : load);
		MinecraftServer s = level.getServer();
		s.execute(() -> TASKS.add(t));
		return t.future;
	}

	static void tick(MinecraftServer server) {
		if (TASKS.isEmpty()) {
			return;
		}
		long end = System.nanoTime() + BUDGET_NANOS;
		Task t = TASKS.get(0);
		try {
			step(t, end);
		} catch (RuntimeException e) {
			release(t);
			TASKS.remove(0);
			t.future.completeExceptionally(e);
			return;
		}
		if (t.done.size() >= t.chunks.size()) {
			release(t);
			TASKS.remove(0);
			t.future.complete(t.cols);
		}
	}

	private static void step(Task t, long end) {
		// read what is loaded; ticket what may be loaded
		for (int i = 0; i < t.chunks.size() && System.nanoTime() < end; i++) {
			long k = t.chunks.get(i);
			if (t.done.contains(k)) {
				continue;
			}
			LevelChunk c = t.level.getChunkSource().getChunkNow(ChunkPos.getX(k), ChunkPos.getZ(k));
			if (c != null) {
				read(t, c);
				t.done.add(k);
				if (t.ticketed.remove(k)) {
					t.level.getChunkSource().removeTicketWithRadius(TICKET, ChunkPos.unpack(k), 0);
				}
				continue;
			}
			if (t.ticketed.contains(k)) {
				continue; // loading
			}
			if (!t.load.loads() || t.loaded >= t.load.maxChunks()) {
				t.done.add(k); // missing
				continue;
			}
			if (!t.load.generate()) {
				ChunkGen.State st = ChunkGen.state(t.level, k);
				if (st == ChunkGen.State.UNKNOWN) {
					continue;
				}
				if (st == ChunkGen.State.NOT_GENERATED) {
					t.done.add(k);
					continue;
				}
			}
			if (t.ticketed.size() >= IN_FLIGHT) {
				continue;
			}
			t.level.getChunkSource().addTicketWithRadius(TICKET, ChunkPos.unpack(k), 0);
			t.ticketed.add(k);
			t.loaded++;
		}
	}

	private static void read(Task t, LevelChunk c) {
		Columns cols = t.cols;
		int bx = c.getPos().getMinBlockX();
		int bz = c.getPos().getMinBlockZ();
		for (int x = bx; x < bx + 16; x++) {
			for (int z = bz; z < bz + 16; z++) {
				int k = cols.at(x, z);
				if (k >= 0) {
					cols.survey(k, c, x, z);
				}
			}
		}
	}

	private static void release(Task t) {
		for (long k : t.ticketed) {
			t.level.getChunkSource().removeTicketWithRadius(TICKET, ChunkPos.unpack(k), 0);
		}
		t.ticketed.clear();
	}

	static String dim(ServerLevel level) {
		return Sites.dimensionId(level);
	}
}
