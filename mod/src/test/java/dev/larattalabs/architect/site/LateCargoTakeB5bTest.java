package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtOps;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.DecoratedPotBlockEntity;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (fix b5b, the GPT review's findings 1 and 5) A container cell's late-cargo take: the units are counted off what the container returns (a
 * decorated pot splits its own stack to zero), and "already restored" is the restored contents exactly: a cell holding the restored block
 * with other items gives those items up, while what the write recreates stays.
 */
class LateCargoTakeB5bTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		// a unit JVM loads no data packs: the items' components (their max stack size) are bound here, as the server's registry load does
		for (var it : new net.minecraft.world.item.Item[] {Items.DIAMOND, Items.FLINT}) {
			var h = it.builtInRegistryHolder();
			if (!h.areComponentsBound()) {
				h.bindComponents(net.minecraft.core.component.DataComponentMap.builder().set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 64)
					.build());
			}
		}
	}

	private static int sum(LateCargo.Taken t) {
		return t.stacks().stream().mapToInt(ItemStack::getCount).sum();
	}

	@Test
	void vanillasPotZeroesTheSlotStackItReturns() {
		// the vanilla behaviour behind finding 1 (26.3 ContainerSingleItem.removeItemNoUpdate -> splitTheItem -> ItemStack.split)
		DecoratedPotBlockEntity pot = new DecoratedPotBlockEntity(BlockPos.ZERO, Blocks.DECORATED_POT.defaultBlockState());
		pot.setTheItem(new ItemStack(Items.DIAMOND, 7));
		ItemStack slot = pot.getItem(0);
		ItemStack got = pot.removeItemNoUpdate(0);
		assertEquals(0, slot.getCount(), "the slot's own stack is split to zero");
		assertEquals(7, got.getCount());
	}

	@Test
	void aPotsCargoIsCountedOffTheReturnedStack() {
		DecoratedPotBlockEntity pot = new DecoratedPotBlockEntity(BlockPos.ZERO, Blocks.DECORATED_POT.defaultBlockState());
		pot.setTheItem(new ItemStack(Items.DIAMOND, 7));
		LateCargo.Taken t = LateCargo.takeCell(pot, i -> null, st -> false);
		assertEquals(7, t.units(), "the units the container gave up (its inventory changed: marked dirty)");
		assertEquals(7, sum(t));
		assertTrue(pot.isEmpty());
		// a chest's slots, the control
		SimpleContainer chest = new SimpleContainer(27);
		chest.setItem(0, new ItemStack(Items.DIAMOND, 3));
		chest.setItem(5, new ItemStack(Items.FLINT, 5));
		LateCargo.Taken c = LateCargo.takeCell(chest, i -> null, st -> false);
		assertEquals(8, c.units());
		assertEquals(8, sum(c));
		assertTrue(chest.isEmpty());
	}

	private static CompoundTag chestNbt(Object... slotItemCount) {
		CompoundTag nbt = new CompoundTag();
		ListTag items = new ListTag();
		for (int k = 0; k < slotItemCount.length; k += 3) {
			CompoundTag e = new CompoundTag();
			e.putByte("Slot", ((Integer) slotItemCount[k]).byteValue());
			e.putString("id", (String) slotItemCount[k + 1]);
			e.putInt("count", (Integer) slotItemCount[k + 2]);
			items.add(e);
		}
		nbt.put("Items", items);
		return nbt;
	}

	@Test
	void aCellHoldingTheRestoredChestWithOtherItemsGivesThemUp() {
		// restored: the terrain's chest with 2 diamonds in slot 0 (the snapshot a forced placement kept)
		Map<Integer, ItemStack> restored = LateCargo.restoredSlots(NbtOps.INSTANCE, chestNbt(0, "minecraft:diamond", 2));
		assertEquals(2, restored.get(0).getCount());
		SimpleContainer chest = new SimpleContainer(27);
		chest.setItem(0, new ItemStack(Items.DIAMOND, 2));
		chest.setItem(1, new ItemStack(Items.FLINT, 5));
		// the block holds the restored value (ownership's holds: a filled chest takes any contents), the contents do not: not restored
		assertFalse(LateCargo.sameContents(chest, restored));
		// a cell the site left (or written back already): the write recreates the 2 diamonds; the 5 flint are cargo
		LateCargo.Taken t = LateCargo.takeCell(chest, restored::get, st -> false);
		assertEquals(5, t.units());
		assertEquals(Items.FLINT, t.stacks().get(0).getItem());
		assertEquals(2, chest.getItem(0).getCount(), "what the write recreates stays");
		// more of the same item than the write recreates: the excess
		chest.setItem(0, new ItemStack(Items.DIAMOND, 9));
		assertEquals(7, LateCargo.takeCell(chest, restored::get, st -> false).units());
		// exactly the restored contents: already restored, nothing taken
		assertTrue(LateCargo.sameContents(chest, restored));
		// the site's own container over that cell: every item is cargo (the snapshot's diamonds come back from the write)
		LateCargo.Taken own = LateCargo.takeCell(chest, i -> null, st -> false);
		assertEquals(2, own.units());
		assertTrue(chest.isEmpty());
	}

	@Test
	void takeUnitsIsTheExcessOverTheSameStack() {
		assertEquals(4, LateCargo.takeUnits(new ItemStack(Items.FLINT, 4), null));
		assertEquals(4, LateCargo.takeUnits(new ItemStack(Items.FLINT, 4), new ItemStack(Items.DIAMOND, 4)), "another item: all of it");
		assertEquals(1, LateCargo.takeUnits(new ItemStack(Items.FLINT, 4), new ItemStack(Items.FLINT, 3)));
		assertEquals(0, LateCargo.takeUnits(new ItemStack(Items.FLINT, 2), new ItemStack(Items.FLINT, 3)));
	}
}
