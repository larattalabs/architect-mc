package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Random;
import java.util.stream.Stream;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.chunk.ImposterProtoChunk;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.storage.RegionFile;
import net.minecraft.world.level.chunk.storage.RegionFileStorage;
import net.minecraft.world.level.chunk.storage.RegionStorageInfo;
import net.minecraft.world.level.storage.LevelResource;

/**
 * (SS, the GPT review's finding 3 and its verification) Behavioural checks of RegionFileFlushMixin, RegionStorageBarrierMixin,
 * ChunkSaveWaitMixin's decision and the ledger's durability check (in a save with the world and in the world save's callback), run in a
 * live server where the mixins are applied ({@code dev.stockpile.ss {probe: true}}; ps-crash asserts every case). Real RegionFile objects in
 * {@code <world>/architect/ss-probe} (storage type "ssprobe", outside the ledger's checks, except cases 9-10's "chunk" file, which must
 * block the ledger), the forces counted as successful ones, the coverage read from {@link RegionDurability} the way the ledger's check
 * reads it. Server thread.
 */
final class SaveProbe {
	private SaveProbe() {
	}

	static JsonObject run(MinecraftServer srv, net.minecraft.server.level.ServerPlayer player) throws IOException {
		JsonObject o = new JsonObject();
		JsonArray cases = new JsonArray();
		Path dir = srv.getWorldPath(LevelResource.ROOT).resolve("architect").resolve("ss-probe");
		Files.createDirectories(dir);
		try (Stream<Path> old = Files.list(dir)) {
			for (Path p : old.toList()) {
				Files.deleteIfExists(p);
			}
		}
		RegionStorageInfo info = new RegionStorageInfo("ss-probe", Level.OVERWORLD, "ssprobe");
		Path f = dir.resolve("r.0.0.mca");
		ChunkPos c0 = new ChunkPos(0, 0);

		// 1 first open: unknown, so the first flush forces (a successful force), even with nothing written by this object
		RegionFile a = new RegionFile(info, f, dir, false);
		RegionDurability.State sa = state(f);
		long f0 = RegionDurability.FORCED.get();
		a.flush();
		add(cases, "firstOpenForces", sa != null && RegionDurability.FORCED.get() == f0 + 1 && sa.forcedAt == 0,
			"forced " + (RegionDurability.FORCED.get() - f0) + ", covered " + (sa == null ? "?" : sa.forcedAt));

		// 2 a clean flush skips
		long s0 = RegionDurability.SKIPPED.get();
		f0 = RegionDurability.FORCED.get();
		a.flush();
		add(cases, "cleanFlushSkips", RegionDurability.SKIPPED.get() == s0 + 1 && RegionDurability.FORCED.get() == f0, "skipped "
			+ (RegionDurability.SKIPPED.get() - s0));

		// 3 a write is undurable until a force covers its generation
		write(a, c0, 2000);
		boolean owing = !RegionDurability.undurable("ssprobe").isEmpty();
		a.flush();
		add(cases, "writeThenFlushCovers", owing && RegionDurability.undurable("ssprobe").isEmpty() && sa.forcedAt == sa.writes.get(), "writes "
			+ sa.writes.get() + ", covered " + sa.forcedAt);

		// 4 a force that fails covers nothing; the retry forces
		write(a, c0, 2000);
		RegionDurability.FAILING.add(f);
		boolean threw = false;
		try {
			a.flush();
		} catch (IOException e) {
			threw = true;
		}
		RegionDurability.FAILING.remove(f);
		boolean stillOwed = !RegionDurability.undurable("ssprobe").isEmpty();
		f0 = RegionDurability.FORCED.get();
		a.flush();
		add(cases, "failedForceRetried", threw && stillOwed && RegionDurability.FORCED.get() == f0 + 1 && RegionDurability.undurable("ssprobe").isEmpty(),
			"threw " + threw + ", owed after it " + stillOwed);

		// 5 a close whose force fails (an eviction) owes its path; a reopened object starts unknown and its first force clears it
		write(a, c0, 2000);
		RegionDurability.FAILING.add(f);
		threw = false;
		try {
			a.close();
		} catch (IOException e) {
			threw = true;
		}
		RegionDurability.FAILING.remove(f);
		boolean owedPath = RegionDurability.OWED.containsKey(f);
		RegionFile b = new RegionFile(info, f, dir, false);
		RegionDurability.State sb = state(f);
		boolean owedAfterReopen = !RegionDurability.undurable("ssprobe").isEmpty();
		b.flush();
		add(cases, "failedCloseThenReopen", threw && owedPath && owedAfterReopen && sb != null && sb.forcedAt == 0 && RegionDurability.undurable("ssprobe").isEmpty(),
			"close threw " + threw + ", owed " + owedPath + ", owed after the reopen " + owedAfterReopen);
		b.close();

		// 7 the device barrier: a storage whose files are all clean still forces one in a new world save
		RegionFileStorage st = new RegionFileStorage(info, dir, false);
		CompoundTag t = new CompoundTag();
		t.putString("ss", "probe");
		st.write(c0, t);
		st.flush();
		RegionDurability.saveStarted();
		long b0 = RegionDurability.BARRIERS.get();
		f0 = RegionDurability.FORCED.get();
		st.flush();
		boolean barrier = RegionDurability.BARRIERS.get() == b0 + 1 && RegionDurability.FORCED.get() == f0 + 1;
		long b1 = RegionDurability.BARRIERS.get();
		st.flush(); // the same world save: no second barrier
		add(cases, "deviceBarrierOncePerSave", barrier && RegionDurability.BARRIERS.get() == b1, "barriers " + (RegionDurability.BARRIERS.get() - b0));
		st.close();

		// 8 a dirty LevelChunk counts, alone and wrapped by an imposter (which itself reports clean)
		ServerLevel lv = srv.overworld();
		if (player != null && player.level() instanceof ServerLevel pl) {
			lv = pl;
		}
		net.minecraft.core.BlockPos at = player != null ? player.blockPosition() : net.minecraft.core.BlockPos.ZERO;
		LevelChunk lc = lv.getChunkSource().getChunkNow(at.getX() >> 4, at.getZ() >> 4);
		boolean waits = false;
		String why = "no loaded chunk at the player";
		if (lc != null) {
			lc.markUnsaved();
			ImposterProtoChunk ip = new ImposterProtoChunk(lc, false);
			boolean was = SaveTiming.explicit;
			SaveTiming.explicit = true; // as inside a stockpile save with the world, where the mixin decides
			try {
				boolean dirtyWaits = !SaveTiming.skipWait(false, lc), imposterWaits = !SaveTiming.skipWait(false, ip);
				boolean protoSkips = SaveTiming.skipWait(false, null), readyWaits = !SaveTiming.skipWait(true, ip);
				SaveTiming.explicit = false;
				boolean vanillaWaits = !SaveTiming.skipWait(false, null);
				waits = dirtyWaits && imposterWaits && protoSkips && readyWaits && vanillaWaits && !ip.isUnsaved();
				why = "dirty LevelChunk waits " + dirtyWaits + ", dirty imposter (itself clean " + !ip.isUnsaved() + ") waits " + imposterWaits
					+ ", nothing to save skips " + protoSkips + ", a ready chunk waits " + readyWaits + ", outside a stockpile save waits " + vanillaWaits;
			} finally {
				SaveTiming.explicit = was;
			}
		}
		add(cases, "waitDecisionKeepsDirtyImposter", waits, why);

		// 9 pending IO from an earlier save: an unflushed save writes the chunk (now clean) without a force; the next save with the world
		// forces that file before the ledger
		boolean pending = false, coveredAfter = false;
		if (lc != null) {
			lv.getChunkSource().save(false);
			lv.getChunkSource().chunkMap.synchronize(false).join();
			java.util.List<RegionDurability.State> rs = regionOf(lc.getPos());
			pending = rs.stream().anyMatch(x -> !x.covered()) && !lc.isUnsaved();
			Stockpiles.saveWithWorld(srv);
			coveredAfter = !rs.isEmpty() && rs.stream().allMatch(RegionDurability.State::covered);
		}
		add(cases, "earlierSavesWritesForcedBeforeLedger", pending && coveredAfter, "unforced before " + pending + ", covered after " + coveredAfter);

		// 9-10 a failure outstanding: an owed chunk-storage file of this world (a close whose force failed) blocks the ledger, in a save with
		// the world and in an autosave; once the disk recovers, the next save retries the path, clears it and publishes the ledger
		Path dx = dir.resolve("chunk");
		Files.createDirectories(dx);
		Path fx = dx.resolve("r.9.9.mca");
		RegionFile x = new RegionFile(new RegionStorageInfo("ss-probe", Level.OVERWORLD, "chunk"), fx, dx, false);
		x.flush();
		write(x, new ChunkPos(9 * 32, 9 * 32), 2000);
		RegionDurability.FAILING.add(fx);
		boolean closeFailed = false;
		try {
			x.close();
		} catch (IOException e) {
			closeFailed = true;
		}
		try {
			int sv0 = Stockpiles.saves, rf0 = Stockpiles.durabilityRefusals;
			boolean threwRefusal = false;
			try {
				Stockpiles.saveWithWorld(srv);
			} catch (IllegalStateException e) {
				threwRefusal = true;
			}
			boolean explicitRefused = threwRefusal && Stockpiles.saves == sv0 && Stockpiles.durabilityRefusals == rf0 + 1;
			srv.saveAllChunks(true, false, false); // an autosave: the world save's callback writes the ledger after J1's wait
			boolean autoRefused = Stockpiles.saves == sv0 && Stockpiles.durabilityRefusals == rf0 + 2;
			add(cases, "ledgerRefusedWhileAFailureIsOutstanding", closeFailed && explicitRefused && autoRefused, "close failed " + closeFailed
				+ ", the save with the world refused " + explicitRefused + ", the autosave refused " + autoRefused + " (saves " + (Stockpiles.saves - sv0) + ")");
			RegionDurability.FAILING.remove(fx); // the disk recovers
			long r0 = RegionDurability.RETRIED.get();
			int sv1 = Stockpiles.saves;
			srv.saveAllChunks(true, false, false);
			boolean autoPublished = Stockpiles.saves == sv1 + 1 && !RegionDurability.OWED.containsKey(fx) && RegionDurability.RETRIED.get() == r0 + 1;
			Stockpiles.saveWithWorld(srv);
			boolean explicitPublished = Stockpiles.saves == sv1 + 2;
			add(cases, "owedPathRetriedThenLedgerPublished", autoPublished && explicitPublished, "the autosave retried and published " + autoPublished
				+ ", then a save with the world published " + explicitPublished);
		} finally {
			RegionDurability.FAILING.remove(fx);
		}

		boolean ok = true;
		for (var e : cases) {
			ok &= e.getAsJsonObject().get("ok").getAsBoolean();
		}
		o.addProperty("ok", ok);
		o.add("cases", cases);
		return o;
	}

	private static void write(RegionFile f, ChunkPos pos, int bytes) throws IOException {
		byte[] b = new byte[bytes];
		new Random(bytes).nextBytes(b); // incompressible: 1.2 MB goes to an external .mcc
		try (DataOutputStream out = f.getChunkDataOutputStream(pos)) {
			out.write(b);
		}
	}

	private static RegionDurability.State state(Path p) {
		for (RegionDurability.State s : RegionDurability.LIVE) {
			if (s.path.equals(p)) {
				return s;
			}
		}
		return null;
	}

	/** The live chunk-storage region files holding {@code pos} (one per level that has that region open). */
	private static java.util.List<RegionDurability.State> regionOf(ChunkPos pos) {
		String name = "r." + pos.getRegionX() + "." + pos.getRegionZ() + ".mca";
		return RegionDurability.LIVE.stream().filter(s -> s.type.equals("chunk") && s.path.getFileName().toString().equals(name)).toList();
	}

	private static void add(JsonArray cases, String name, boolean ok, String detail) {
		JsonObject c = new JsonObject();
		c.addProperty("case", name);
		c.addProperty("ok", ok);
		c.addProperty("detail", detail);
		cases.add(c);
	}
}
