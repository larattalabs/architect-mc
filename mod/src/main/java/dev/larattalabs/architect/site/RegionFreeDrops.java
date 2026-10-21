package dev.larattalabs.architect.site;

import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.region.RegionsImpl;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (6c RS, N-RS-2: the coordinator's decision, anti-dupe) A survival region's free cells cost nothing, so a player breaking one would mine
 * free blocks: while a cell is still the region's write (the top journal entry there is the region's free-pass tile entry, or a target's
 * held cell, and the world holds what it wrote) a player breaking it gets no drop (the block goes, as mined). A paid cell drops as
 * vanilla (it was paid for; the removal then refunds nothing for it). Undo restores as today. Server thread.
 */
public final class RegionFreeDrops {
	/** Dev: free cells broken without a drop this session. */
	public static final AtomicLong BROKEN = new AtomicLong();

	private RegionFreeDrops() {
	}

	static void init() {
		PlayerBlockBreakEvents.BEFORE.register(RegionFreeDrops::before);
	}

	private static boolean before(Level level, Player player, BlockPos pos, BlockState state, @Nullable BlockEntity be) {
		if (level.isClientSide() || !(level instanceof ServerLevel sl) || player.isCreative() || player.isSpectator()) {
			return true;
		}
		RegionsImpl.Live l = freeWriteOf(sl, pos);
		if (l == null) {
			return true;
		}
		sl.destroyBlock(pos, false, player);
		BROKEN.incrementAndGet();
		// (§9, item 15) remembered: the removal puts the region's write back first, so its undo restores the land as it was
		com.google.gson.JsonArray mined = l.rec().survival.getAsJsonArray("mined");
		if (mined == null) {
			mined = new com.google.gson.JsonArray();
			l.rec().survival.add("mined", mined);
		}
		mined.add(pos.asLong());
		RegionsImpl.saveRec(l);
		return false;
	}

	/** Whether the cell is a survival region's free write still standing (its free pass, or a target's held cell). */
	public static boolean freeWrite(ServerLevel level, BlockPos pos) {
		return freeWriteOf(level, pos) != null;
	}

	/**
	 * (§9) At a survival region's removal: each free cell a player mined (no drop) that is still air under the region's write gets that
	 * write back, so the undo restores what stood before. Server thread.
	 */
	public static void restoreMined(ServerLevel level, RegionsImpl.Live l) {
		if (l.rec().survival == null || !(l.rec().survival.get("mined") instanceof com.google.gson.JsonArray mined)) {
			return;
		}
		String dim = Sites.dimensionId(level);
		int n = 0;
		for (var e : mined) {
			long p = e.getAsLong();
			BlockPos bp = BlockPos.of(p);
			if (!level.getBlockState(bp).isAir()) {
				continue;
			}
			try {
				List<WorldJournal.Layer> st = WorldJournal.stack(dim, p);
				WorldJournal.Layer top = st.isEmpty() ? null : st.get(st.size() - 1);
				Infra i = top == null ? null : Infras.get(top.meta().site());
				if (i == null || !java.util.Objects.equals(i.group(), l.rec().groupId) || top.cell().after() == null) {
					continue;
				}
				dev.larattalabs.architect.placed.Placed.set(level, bp, WorldJournal.state(top.cell().after()), Sites.CELL_FLAGS);
				n++;
			} catch (IOException x) {
				// unreadable: left as mined
			}
		}
		l.rec().survival.remove("mined");
		RegionsImpl.saveRec(l);
		if (n > 0) {
			dev.larattalabs.architect.Architect.LOGGER.info("Region {}: {} mined free cell(s) put back before its removal", l.rec().id, n);
		}
	}

	/** The survival region whose free write stands at the cell (its free pass, or a target's held cell), or null. */
	static RegionsImpl.@Nullable Live freeWriteOf(ServerLevel level, BlockPos pos) {
		String dim = Sites.dimensionId(level);
		long p = pos.asLong();
		List<WorldJournal.Layer> st;
		try {
			st = WorldJournal.stack(dim, p);
		} catch (IOException e) {
			return null;
		}
		WorldJournal.Layer top = null;
		for (int k = st.size() - 1; k >= 0; k--) {
			if (!st.get(k).meta().kind().equals(WorldJournal.LEAVES)) {
				top = st.get(k);
				break;
			}
		}
		if (top == null || top.cell().after() == null) {
			return null;
		}
		Infra i = Infras.get(top.meta().site());
		if (i == null || i.road() || i.group() == null) {
			return null;
		}
		SiteGroupRec g = Sites.group(i.group());
		if (g == null || !g.ext().has(RegionItems.EXT_REGION)) {
			return null;
		}
		var l = RegionsImpl.live(g.ext().get(RegionItems.EXT_REGION).getAsString());
		if (l == null || !l.rec().survival()) {
			return null;
		}
		if (RegionTargets.is(i)) {
			Builder.Run r = RoadBuilder.run(level.getServer(), i);
			RegionTargets.Plan pl = r == null ? null : RegionTargets.planOf(level.getServer(), i);
			int q = r == null ? -1 : r.queuePos(pos);
			if (q < 0 || pl == null || !pl.held.get(q)) {
				return null; // a paid cell: vanilla drops
			}
		}
		return WorldJournal.holds(level, p, top.cell().after()) ? l : null;
	}
}
