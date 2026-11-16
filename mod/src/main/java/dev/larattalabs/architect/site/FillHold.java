package dev.larattalabs.architect.site;

import dev.larattalabs.architect.placement.Blueprints;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * (Slice FL, Steward's S-M5-17) A fill site's declared containers take no item by any automated transfer until the site is unlocked. FK
 * promises a fill site is built "with its locks locked", but a lock cell is an attachable (a lever): the builder puts it down after the row's
 * hoppers and writes it with {@link Sites#FLAGS} (no neighbour update), so the hoppers already standing never see its power until the fill
 * tick re-asserts it; and a lock only disables the hoppers beside it, so a line hopper elsewhere feeds the filter hopper under it anyway.
 * In game a player's 64 cobblestone in the input chest reached F0 mid-build (the fill then waited {@code fill_blocked}).
 *
 * <p>So the guard holds the containers themselves, whatever the build order, the stock skipping a cell, or the module's circuit: every
 * vanilla insertion into a block container (a hopper's push, a hopper's pull from the container above, a hopper picking up an item entity,
 * a dropper's push) passes {@code HopperBlockEntity.canPlaceItemInContainer}, which {@code HopperHoldMixin} refuses for a declared
 * container of a site whose fill phase is not {@link Fills#UNLOCKED}. The item stays where it was (no loss, no mint). A player's own hand
 * into a declared container stays FK's cargo ({@code fill_blocked}). After the unlock the containers behave as vanilla.
 *
 * <p>The index (per dimension, the declared containers' cells) is rebuilt when the sites store's map changes (copy-on-write, so an identity
 * check covers place, phase writes, removal and load) or the library's revision moves; with no pending fill site the lookup ends at once.
 * Server thread.
 */
public final class FillHold {
	private FillHold() {
	}

	private static @Nullable Object builtFrom;
	private static long builtRevision = Long.MIN_VALUE;
	private static Map<String, LongOpenHashSet> index = Map.of();
	/** (TEST, {@code dev.fk.state}) Insertions refused since the start. */
	public static long held;

	/** Whether a site's declared containers are held: it has a fill and its phase is not UNLOCKED (none yet, FILLING or FILLED). */
	static boolean holds(Site s, Fills.@Nullable Spec spec) {
		return spec != null && !spec.containers().isEmpty() && !Fills.UNLOCKED.equals(Fills.phase(s));
	}

	/** (pure) The held cells per dimension of {@code sites}, a site's spec from {@code specOf}. */
	static Map<String, LongOpenHashSet> index(Collection<Site> sites, Function<Site, Fills.@Nullable Spec> specOf) {
		Map<String, LongOpenHashSet> out = new HashMap<>();
		for (Site s : sites) {
			Fills.Spec spec = specOf.apply(s);
			if (!holds(s, spec)) {
				continue;
			}
			LongOpenHashSet set = out.computeIfAbsent(s.dimension(), d -> new LongOpenHashSet());
			for (Fills.Box b : spec.containers()) {
				set.add(Fills.world(s, b.x(), b.y(), b.z()).asLong());
			}
		}
		return out;
	}

	private static Map<String, LongOpenHashSet> current(MinecraftServer srv) {
		Object now = Sites.storeIdentity();
		long rev = Blueprints.revision();
		if (now != builtFrom || rev != builtRevision) {
			index = index(Sites.all(), s -> Fills.of(srv, s));
			builtFrom = now;
			builtRevision = rev;
		}
		return index;
	}

	/** Whether the block container at {@code pos} of {@code level} is a held declared container. */
	public static boolean held(@Nullable Level level, net.minecraft.core.BlockPos pos) {
		if (!(level instanceof ServerLevel sl)) {
			return false;
		}
		Map<String, LongOpenHashSet> m = current(sl.getServer());
		if (m.isEmpty()) {
			return false;
		}
		LongOpenHashSet set = m.get(Sites.dimensionId(sl));
		return set != null && set.contains(pos.asLong());
	}

	/** (from {@code HopperHoldMixin}) Whether an automated insertion into slot {@code slot} of {@code dest} is refused. */
	public static boolean refusesInsert(Container dest, int slot) {
		FillGuard.Cell cell = FillGuard.resolve(dest, slot);
		if (cell == null || !held(cell.be().getLevel(), cell.be().getBlockPos())) {
			return false;
		}
		held++;
		return true;
	}
}
