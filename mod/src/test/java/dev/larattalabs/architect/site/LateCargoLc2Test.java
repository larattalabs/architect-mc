package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtOps;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.Container;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.CampfireBlockEntity;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.entity.LecternBlockEntity;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (Slice LC2) The redone "already restored" rule (the v0.73.0 RC fix review's #5): totals per item, the own-template rule before any skip,
 * the write mark for a restore written again; the item-holder table (lecterns, campfires); F10's drop height.
 */
class LateCargoLc2Test {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		for (var it : new net.minecraft.world.item.Item[] {Items.DIAMOND, Items.FLINT, Items.WRITABLE_BOOK, Items.BEEF}) {
			var h = it.builtInRegistryHolder();
			if (!h.areComponentsBound()) {
				h.bindComponents(net.minecraft.core.component.DataComponentMap.builder().set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE,
					it == Items.WRITABLE_BOOK ? 1 : 64).build());
			}
		}
	}

	private static Map<Integer, ItemStack> restoredChest(int slot, int diamonds) {
		CompoundTag nbt = new CompoundTag();
		ListTag items = new ListTag();
		CompoundTag e = new CompoundTag();
		e.putByte("Slot", (byte) slot);
		e.putString("id", "minecraft:diamond");
		e.putInt("count", diamonds);
		items.add(e);
		nbt.put("Items", items);
		return LateCargo.restoredSlots(NbtOps.INSTANCE, nbt);
	}

	private static int total(Container c) {
		int n = 0;
		for (int i = 0; i < c.getContainerSize(); i++) {
			n += c.getItem(i).getCount();
		}
		return n;
	}

	@Test
	void restoredItemsMovedToAnotherSlotAreNotTakenAgain() {
		// GPT's P1 at 9d523816: 2 restored diamonds moved from slot 0 to slot 1, a restart, the restore writes again. Per slot (b5b) they were
		// cargo (2 dropped) and the write put 2 back: 4. By totals per item they are what the write recreates: nothing taken.
		Map<Integer, ItemStack> restored = restoredChest(0, 2);
		SimpleContainer chest = new SimpleContainer(27);
		chest.setItem(1, new ItemStack(Items.DIAMOND, 2));
		LateCargo.Taken t = LateCargo.takeCell(chest, LateCargo.recreated(false, false, restored), st -> false);
		assertEquals(0, t.units(), "the moved restored stack stays");
		assertEquals(2, total(chest));
		// split over two slots, plus 3 of a player's: only the 3 past the restored total
		chest.setItem(1, new ItemStack(Items.DIAMOND, 1));
		chest.setItem(7, new ItemStack(Items.DIAMOND, 4));
		LateCargo.Taken x = LateCargo.takeCell(chest, LateCargo.recreated(false, false, restored), st -> false);
		assertEquals(3, x.units());
		assertEquals(2, total(chest));
	}

	@Test
	void theOwnTemplateRuleComesBeforeAnyMatch() {
		// GPT's P1 at 9d523816: a site forced over a terrain chest of 2 diamonds; 2 independent diamonds put into the site's own chest in the
		// same slot after the blocker scan. Its contents equal the restored ones, yet every item there is cargo (the write recreates the
		// terrain's 2): before LC2 the exact match skipped the cell and the late 2 were erased.
		Map<Integer, ItemStack> restored = restoredChest(0, 2);
		SimpleContainer own = new SimpleContainer(27);
		own.setItem(0, new ItemStack(Items.DIAMOND, 2));
		assertTrue(LateCargo.recreated(true, false, restored).isEmpty(), "an own template cell not written yet: nothing stays");
		LateCargo.Taken t = LateCargo.takeCell(own, LateCargo.recreated(true, false, restored), st -> false);
		assertEquals(2, t.units());
		assertTrue(own.isEmpty());
	}

	@Test
	void anOwnCellThisRemovalWroteKeepsWhatItWrote() {
		// the same own cell after this removal wrote it (its mark saved with the chunk), the restore written again after a restart: the
		// terrain's 2 diamonds it holds are what the write recreates; without the mark the own rule would hand them out and write 2 more
		Map<Integer, ItemStack> restored = restoredChest(0, 2);
		SimpleContainer written = new SimpleContainer(27);
		written.setItem(3, new ItemStack(Items.DIAMOND, 2));
		assertEquals(1, LateCargo.recreated(true, true, restored).size());
		assertEquals(0, LateCargo.takeCell(written, LateCargo.recreated(true, true, restored), st -> false).units());
		assertEquals(2, total(written));
		// a player's late stack there after the write: the excess
		written.setItem(4, new ItemStack(Items.FLINT, 6));
		assertEquals(6, LateCargo.takeCell(written, LateCargo.recreated(true, true, restored), st -> false).units());
	}

	@Test
	void providedStacksStayAndDoNotUseTheAllowance() {
		Map<Integer, ItemStack> restored = restoredChest(0, 2);
		SimpleContainer c = new SimpleContainer(27);
		c.setItem(0, new ItemStack(Items.FLINT, 5));
		c.setItem(1, new ItemStack(Items.DIAMOND, 2));
		LateCargo.Taken t = LateCargo.takeCell(c, LateCargo.recreated(false, false, restored), st -> st.is(Items.FLINT));
		assertEquals(0, t.units());
		assertEquals(7, total(c));
	}

	@Test
	void lecternsAndCampfiresAreItemHolders() {
		// GPT's P1 (finding 6): neither is a Container in 26.3; one table serves the take and the blocker scan
		LecternBlockEntity lectern = new LecternBlockEntity(BlockPos.ZERO, Blocks.LECTERN.defaultBlockState());
		Container l = LateCargo.holder(lectern);
		assertNotNull(l);
		assertTrue(l.isEmpty());
		lectern.setBook(new ItemStack(Items.WRITABLE_BOOK));
		assertFalse(l.isEmpty());
		LateCargo.Taken t = LateCargo.takeCell(l, List.of(), st -> false);
		assertEquals(1, t.units());
		assertEquals(Items.WRITABLE_BOOK, t.stacks().get(0).getItem());
		assertTrue(lectern.getBook().isEmpty(), "the book is out of the lectern");
		// a restored lectern's book (its Book tag) is what its write recreates
		CompoundTag nbt = new CompoundTag();
		CompoundTag book = new CompoundTag();
		book.putString("id", "minecraft:writable_book");
		book.putInt("count", 1);
		nbt.put("Book", book);
		assertEquals(Items.WRITABLE_BOOK, LateCargo.restoredSlots(NbtOps.INSTANCE, nbt).get(0).getItem());

		CampfireBlockEntity fire = new CampfireBlockEntity(BlockPos.ZERO, Blocks.CAMPFIRE.defaultBlockState());
		Container f = LateCargo.holder(fire);
		assertNotNull(f);
		assertEquals(4, f.getContainerSize());
		fire.getItems().set(2, new ItemStack(Items.BEEF, 1));
		assertFalse(f.isEmpty());
		LateCargo.Taken c = LateCargo.takeCell(f, List.of(), st -> false);
		assertEquals(1, c.units());
		assertTrue(fire.getItems().get(2).isEmpty());

		assertNotNull(LateCargo.holder(new ChestBlockEntity(BlockPos.ZERO, Blocks.CHEST.defaultBlockState())));
		assertNull(LateCargo.holder(null));
	}

	@Test
	void aPlayersBlockDropsOnTopOfTheBlockWrittenBack() {
		// F10: the gravel spawned at y + 0.25 inside the grass block the cell got back; vanilla pushed it toward a free neighbour, off the cell
		double top = Blocks.GRASS_BLOCK.defaultBlockState().getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).max(Direction.Axis.Y);
		assertEquals(1.0, top, 1e-9);
		double y = Builder.dropY(64, top);
		assertTrue(y >= 64 + top, "never inside the block: " + y);
		assertTrue(64 + 0.25 < 64 + top, "the old spawn was inside it");
		assertEquals(64.25, Builder.dropY(64, Double.NaN), 1e-9); // a cell with no collision shape: as before
		double slab = Blocks.STONE_SLAB.defaultBlockState().getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).max(Direction.Axis.Y);
		assertTrue(Builder.dropY(64, slab) >= 64.5);
	}
}
