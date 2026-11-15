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
 * (SS, the GPT review's finding 3) Behavioural checks of RegionFileFlushMixin, RegionStorageBarrierMixin and ChunkSaveWaitMixin, run in a
 * live server where the mixins are applied ({@code dev.stockpile.ss {probe: true}}; ps-crash asserts every case). Real RegionFile objects in
 * {@code <world>/architect/ss-probe} (storage type "ssprobe", outside the ledger's checks), the forces counted as successful ones, the
 * coverage read from {@link RegionDurability} the way the ledger's check reads it. Server thread.
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
		RegionDurability.failNextForce = f;
		boolean threw = false;
		try {
			a.flush();
		} catch (IOException e) {
			threw = true;
		}
		boolean stillOwed = !RegionDurability.undurable("ssprobe").isEmpty();
		f0 = RegionDurability.FORCED.get();
		a.flush();
		add(cases, "failedForceRetried", threw && stillOwed && RegionDurability.FORCED.get() == f0 + 1 && RegionDurability.undurable("ssprobe").isEmpty(),
			"threw " + threw + ", owed after it " + stillOwed);

		// 5 a close whose force fails (an eviction) owes its path; a reopened object starts unknown and its first force clears it
		write(a, c0, 2000);
		RegionDurability.failNextForce = f;
		threw = false;
		try {
			a.close();
		} catch (IOException e) {
			threw = true;
		}
		boolean owedPath = RegionDurability.OWED.containsKey(f);
		RegionFile b = new RegionFile(info, f, dir, false);
		RegionDurability.State sb = state(f);
		boolean owedAfterReopen = !RegionDurability.undurable("ssprobe").isEmpty();
		b.flush();
		add(cases, "failedCloseThenReopen", threw && owedPath && owedAfterReopen && sb != null && sb.forcedAt == 0 && RegionDurability.undurable("ssprobe").isEmpty(),
			"close threw " + threw + ", owed " + owedPath + ", owed after the reopen " + owedAfterReopen);
		b.close();

		// 6 an oversized chunk: its .mcc payload forced, the directory synced at the next forcing flush
		Path f2 = dir.resolve("r.1.0.mca");
		RegionFile c = new RegionFile(info, f2, dir, false);
		RegionDurability.State sc = state(f2);
		long d0 = RegionDurability.DIR_SYNCS.get();
		write(c, new ChunkPos(32, 0), 1_200_000);
		boolean ext = sc != null && sc.external.get() == 1 && Files.exists(dir.resolve("c.32.0.mcc"));
		c.flush();
		add(cases, "oversizedChunkDurable", ext && RegionDurability.DIR_SYNCS.get() == d0 + 1 && RegionDurability.undurable("ssprobe").isEmpty(),
			"external " + ext + ", dir syncs " + (RegionDurability.DIR_SYNCS.get() - d0));
		c.close();

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
		boolean dirty = false;
		if (lc != null) {
			lc.markUnsaved();
			ImposterProtoChunk ip = new ImposterProtoChunk(lc, false);
			dirty = SaveTiming.hasChanges(lc) && SaveTiming.hasChanges(ip) && !ip.isUnsaved();
		}
		add(cases, "dirtyImposterWaited", dirty, lc == null ? "no loaded chunk at spawn" : "LevelChunk and imposter both have changes");

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
