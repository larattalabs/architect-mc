package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (Slice LC, S-M5-12) A removal's late cargo: what of a container cell stays with the restore's write and what is handed out, and the
 * restore's cell lookup the take is limited to.
 */
class LateCargoTest {
	@Test
	void survivalContainersHoldNothingOurs() {
		// a survival (construction) site's declared container is empty after its custody take: a declared item within the declaration is cargo
		assertFalse(LateCargo.containerOurs(false, true, true));
		assertFalse(LateCargo.containerOurs(false, false, true));
		// an undeclared container (the hall's input chest): never ours, survival or creative
		assertFalse(LateCargo.containerOurs(false, false, false));
		assertFalse(LateCargo.containerOurs(true, false, true));
	}

	@Test
	void creativeFillWithinItsDeclarationGoesWithTheWrite() {
		assertTrue(LateCargo.containerOurs(true, true, true)); // FK §5: creative contents go with the cell's write
		assertFalse(LateCargo.containerOurs(true, true, false)); // more than declared: the extra is a player's
	}

	@Test
	void providedItemsNeverHandedOut() {
		assertTrue(LateCargo.stackOurs(true, true)); // FK-b: a provided item in a declared container is destroyed, never dropped
		assertFalse(LateCargo.stackOurs(true, false));
		assertFalse(LateCargo.stackOurs(false, true)); // outside a declared container the same id is a player's
	}

	@Test
	void restoreWritesOnlyItsCells() {
		var ct = new net.minecraft.nbt.CompoundTag();
		ct.putString("Name", "minecraft:chest");
		var at = new net.minecraft.nbt.CompoundTag();
		at.putString("Name", "minecraft:air");
		var chest = new dev.larattalabs.architect.journal.Journal.Value(ct, null);
		var air = new dev.larattalabs.architect.journal.Journal.Value(at, null);
		long inBox = net.minecraft.core.BlockPos.asLong(1, 2, 3);
		long cell = net.minecraft.core.BlockPos.asLong(9, 9, 9);
		var r = new SiteJournal.Restore("s", null, new net.minecraft.nbt.CompoundTag(), null, List.of(new SiteJournal.CellWrite(cell, air, 0)), List.of(),
			List.of(), new int[0], 0, new it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<>(), Map.of(inBox, chest));
		assertEquals(chest, r.writes(inBox));
		assertEquals(air, r.writes(cell));
		assertNull(r.writes(net.minecraft.core.BlockPos.asLong(0, 0, 0)));
		var noTemplate = new SiteJournal.Restore("s", null, null, null, List.of(), List.of(), List.of(), new int[0], 0,
			new it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<>(), Map.of(inBox, chest));
		assertNull(noTemplate.writes(inBox));
	}
}
