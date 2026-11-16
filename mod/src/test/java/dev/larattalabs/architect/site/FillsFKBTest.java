package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.survival.StockLedger;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (FK-b, docs/CONTRACT.md "### FK-b contract") Module-provided fill items: the declaration's split (the bill without them, the boxes' full
 * declaration with them), the mod's refusals (the kit's strings), the ledger's {@code provided}/{@code heldProvided} (saved, dropped at the
 * credit refunding nothing), the allow-list's identity check, and the optional Transfer API guard's target as our Fabric API has it.
 * (The guard index, the strip and the menu, hopper and Transfer API refusals need a world and the mixins: in game, fkb-survival.)
 */
class FillsFKBTest {
	static final String KEY = FillsFKTest.KEY;
	static final String FLINT = "minecraft:flint";
	static final String SLAB = "minecraft:petrified_oak_slab";
	static final String HOPPER = FillsFKTest.HOPPER;

	@BeforeAll
	static void boot() {
		FillsFKTest.boot();
	}

	static final String HALL = "{\"containers\": [{\"at\": [1, 2, 1], \"items\": [{\"slot\": 0, \"id\": \"minecraft:flint\", \"count\": 18}, "
		+ "{\"slot\": 1, \"id\": \"minecraft:petrified_oak_slab\", \"count\": 1, \"provided\": true}, "
		+ "{\"slot\": 2, \"id\": \"minecraft:petrified_oak_slab\", \"count\": 1, \"provided\": true}]}, "
		+ "{\"at\": [2, 2, 1], \"items\": [{\"slot\": 0, \"id\": \"minecraft:petrified_oak_slab\", \"count\": 4, \"provided\": true}]}], \"locks\": []}";

	static String one(String item) {
		return "{\"containers\": [{\"at\": [0,0,0], \"items\": [" + item + "]}]}";
	}

	@Test
	void theBillLeavesTheProvidedItemsOutTheDeclarationKeepsThem() {
		Fills.Spec s = Fills.parse(FillsFKTest.entry(HALL, true));
		assertEquals(Map.of(FLINT, 18), s.billed(), "the bill: the filter items only");
		assertEquals(Map.of(SLAB, 6), s.provided());
		assertEquals(Map.of(FLINT, 18, SLAB, 6), s.items(), "what the fill writes");
		assertEquals(1, s.costs().size());
		assertEquals(Map.of(FLINT, 18, SLAB, 2), s.containers().get(0).counts(), "a box's declaration counts the slabs as ours (never cargo)");
		assertEquals(java.util.Set.of(SLAB), s.containers().get(0).providedItems());
		assertTrue(s.containers().get(0).items().get(1).provided());
		assertFalse(s.containers().get(0).items().get(0).provided());
		assertTrue(Fills.parse(FillsFKTest.entry(HALL, true)).containers().get(1).items().stream().allMatch(Fills.Stack::provided));
		assertTrue(Fills.parse(FillsFKTest.entry(one("{\"slot\": 0, \"id\": \"minecraft:petrified_oak_slab\", \"count\": 3, \"provided\": true}"), true))
			.billed().isEmpty(), "provided items only: an empty bill");
		assertNull(Fills.refusal(FillsFKTest.entry(HALL, true)));
		assertEquals(Map.of(FLINT, 18), new Fills.Stack(0, FLINT, 18).provided() ? Map.of() : Map.of(FLINT, 18), "the 3-arg Stack is billed");
	}

	@Test
	void theModRefusesAsTheKitDoes() {
		assertEquals("fill: minecraft:diamond can't be module-provided (allowed: minecraft:petrified_oak_slab)",
			Fills.refusal(FillsFKTest.entry(one("{\"slot\": 0, \"id\": \"minecraft:diamond\", \"count\": 1, \"provided\": true}"), true)));
		assertEquals("fill: minecraft:petrified_oak_slab is creative-only; declare it provided: true",
			Fills.refusal(FillsFKTest.entry(one("{\"slot\": 0, \"id\": \"minecraft:petrified_oak_slab\", \"count\": 1}"), true)));
		assertEquals("fill: minecraft:petrified_oak_slab is creative-only; declare it provided: true",
			Fills.refusal(FillsFKTest.entry(one("{\"slot\": 0, \"id\": \"minecraft:petrified_oak_slab\", \"count\": 1, \"provided\": false}"), true)));
		assertEquals("fill: provided must be true or false",
			Fills.refusal(FillsFKTest.entry(one("{\"slot\": 0, \"id\": \"minecraft:petrified_oak_slab\", \"count\": 1, \"provided\": \"yes\"}"), true)));
		Fills.Spec s = Fills.parse(FillsFKTest.entry(HALL, true));
		assertEquals("fill: a provided item can't go in a dropper", Fills.providedCellRefusal(s, (x, y, z) -> x == 2 ? Blocks.DROPPER : Blocks.HOPPER));
		assertEquals("fill: a provided item can't go in a dispenser", Fills.providedCellRefusal(s, (x, y, z) -> Blocks.DISPENSER));
		assertNull(Fills.providedCellRefusal(s, (x, y, z) -> x == 1 ? Blocks.CHEST : Blocks.BARREL));
		Fills.Spec billedOnly = Fills.parse(FillsFKTest.entry(one("{\"slot\": 0, \"id\": \"minecraft:flint\", \"count\": 1}"), true));
		assertNull(Fills.providedCellRefusal(billedOnly, (x, y, z) -> Blocks.DROPPER), "a billed item in a dropper is FK's (allowed)");
	}

	@Test
	void theSplitOfWhatARemovalTakes() {
		Map<String, Integer> took = Map.of(FLINT, 10, SLAB, 6);
		assertEquals(Map.of(FLINT, 10), Fills.part(took, false), "into custody (refunded with the blocks)");
		assertEquals(Map.of(SLAB, 6), Fills.part(took, true), "held apart (never refunded; destroyed when it has no slot at a write-back)");
		assertTrue(Fills.providedItem(SLAB));
		assertFalse(Fills.providedItem("minecraft:oak_slab"));
	}

	@Test
	void theLedgerKeepsTheProvidedApartAndTheCreditRefundsNoneOfThem() {
		StockLedger l = FillsFKTest.paid(Map.of(HOPPER, 2), Map.of(FLINT, 18));
		l.markFilled(KEY, Map.of(SLAB, 6));
		assertEquals(Map.of(SLAB, 6), l.provided(KEY));
		assertFalse(l.paid().get(KEY).containsKey(SLAB), "unbilled: never in paid[key]");
		l.holdCustody(KEY, Map.of(FLINT, 18));
		l.holdProvided(KEY, Map.of(SLAB, 6));
		JsonObject j = l.toJson();
		assertTrue(j.has("provided") && j.has("heldProvided"), "additive format-2 members");
		StockLedger back = StockLedger.fromJson(JsonParser.parseString(j.toString()).getAsJsonObject());
		assertEquals(Map.of(SLAB, 6), back.provided(KEY));
		assertEquals(Map.of(SLAB, 6), back.heldProvided(KEY));
		assertEquals(java.util.Set.of(KEY), back.heldProvidedKeys());
		StockLedger.Credit c = back.credit(KEY, Map.of(HOPPER, 2), FillsFKTest.CAP, FillsFKTest.MAX);
		assertEquals(Map.of(HOPPER, 2, FLINT, 18), c.returned(), "the billed part only: no slab refunded");
		assertFalse(c.returned().containsKey(SLAB) || c.overflow().containsKey(SLAB));
		assertTrue(back.provided(KEY).isEmpty() && back.heldProvided(KEY).isEmpty(), "both dropped at the credit");
		assertTrue(back.identityHolds());
		assertFalse(back.toJson().has("provided") || back.toJson().has("heldProvided"), "absent when unused");
		assertTrue(back.credit(KEY, Map.of(HOPPER, 2), FillsFKTest.CAP, FillsFKTest.MAX).already(), "credited once");
	}

	@Test
	void aRemovalEndingUnwrittenReleasesTheHeldProvided() {
		StockLedger l = new StockLedger();
		l.holdProvided(KEY, Map.of(SLAB, 4));
		l.holdProvided(KEY, Map.of(SLAB, 2));
		assertEquals(Map.of(SLAB, 6), l.releaseProvided(KEY));
		assertTrue(l.heldProvided(KEY).isEmpty());
		assertTrue(l.releaseProvided(KEY).isEmpty());
		assertTrue(new StockLedger().toJson().keySet().stream().noneMatch(k -> k.equals("provided") || k.equals("heldProvided")));
	}

	@Test
	void theAllowListIsAnIdentityCheckOnTheItem() {
		// (a stack needs bound item components, so the stack-level checks run in game; the set is what they test first)
		assertEquals(java.util.Set.of(Items.PETRIFIED_OAK_SLAB), FillGuard.providedItems());
		assertFalse(FillGuard.providedItems().contains(Items.OAK_SLAB));
		assertFalse(FillGuard.allowListed(ItemStack.EMPTY));
		assertFalse(FillGuard.guarded(null, net.minecraft.core.BlockPos.ZERO, ItemStack.EMPTY), "no server level: never guarded");
	}

	/**
	 * (5d) The optional Transfer API guard's target as our Fabric API has it: the class, the extract signature the injector names, and
	 * the fields the guard reads. A Fabric API bump that renames any of them fails this test (and the gate's in-game Transfer API case)
	 * before players see the start's WARN.
	 */
	@Test
	void theTransferApiGuardsTargetIsInOurFabricApi() throws Exception {
		Class<?> w = Class.forName(FillGuard.TRANSFER_WRAPPER);
		Method m = w.getDeclaredMethod("extract", net.fabricmc.fabric.api.transfer.v1.item.ItemVariant.class, long.class,
			net.fabricmc.fabric.api.transfer.v1.transaction.TransactionContext.class);
		assertEquals(long.class, m.getReturnType());
		// (slice LC3) the removal seal's insert injector
		assertEquals(long.class, w.getDeclaredMethod("insert", net.fabricmc.fabric.api.transfer.v1.item.ItemVariant.class, long.class,
			net.fabricmc.fabric.api.transfer.v1.transaction.TransactionContext.class).getReturnType());
		Field storage = w.getDeclaredField("storage");
		assertEquals(int.class, w.getDeclaredField("slot").getType());
		Field container = storage.getType().getDeclaredField("container");
		assertEquals(net.minecraft.world.Container.class, container.getType());
		// the mixin's own descriptor matches it
		var inj = dev.larattalabs.architect.compatmixin.ContainerSlotWrapperMixin.class.getDeclaredMethods();
		java.util.Set<String> targets = new java.util.TreeSet<>();
		for (Method x : inj) {
			var a = x.getAnnotation(org.spongepowered.asm.mixin.injection.Inject.class);
			if (a != null) {
				targets.add(a.method()[0]);
			}
		}
		assertEquals(java.util.Set.of("extract(Lnet/fabricmc/fabric/api/transfer/v1/item/ItemVariant;JLnet/fabricmc/fabric/api/transfer/v1/transaction/TransactionContext;)J",
			"insert(Lnet/fabricmc/fabric/api/transfer/v1/item/ItemVariant;JLnet/fabricmc/fabric/api/transfer/v1/transaction/TransactionContext;)J"), targets);
		assertNotNull(Class.forName("dev.larattalabs.architect.compat.TransferGuardPlugin"));
		// @Mixin is class-retained: its target string is in the mixin's class file
		try (var in = dev.larattalabs.architect.compatmixin.ContainerSlotWrapperMixin.class.getResourceAsStream("ContainerSlotWrapperMixin.class")) {
			String bytes = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.ISO_8859_1);
			assertTrue(bytes.contains(FillGuard.TRANSFER_WRAPPER), "the mixin targets " + FillGuard.TRANSFER_WRAPPER);
		}
		String cfg = new String(FillsFKBTest.class.getResourceAsStream("/architect_mc.compat.mixins.json").readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
		JsonObject c = JsonParser.parseString(cfg).getAsJsonObject();
		assertFalse(c.get("required").getAsBoolean(), "the optional config never fails the mod's load");
		assertEquals("dev.larattalabs.architect.compat.TransferGuardPlugin", c.get("plugin").getAsString());
		String mod = new String(FillsFKBTest.class.getResourceAsStream("/fabric.mod.json").readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
		assertTrue(mod.contains("architect_mc.compat.mixins.json"), "registered in fabric.mod.json");
	}

	@Test
	void aFillOfOnlyBilledItemsIsFKUnchanged() {
		Fills.Spec s = Fills.parse(FillsFKTest.entry(FillsFKTest.ONE, true));
		assertEquals(s.items(), s.billed());
		assertTrue(s.provided().isEmpty());
		StockLedger l = new StockLedger();
		l.markFilled(KEY, Map.of());
		assertTrue(l.filled(KEY));
		assertFalse(l.toJson().has("provided"));
		assertEquals(new TreeMap<>(), new TreeMap<>(l.provided(KEY)));
	}

	@Test
	void providedItemsGoOnlyIntoTheDeclaredBlockNeverADropperOrDispenser() {
		// (FK-b fix) the live block at a declared cell: a hopper swapped for a dropper (or a dispenser, a chest) takes no provided item
		assertTrue(Fills.providedFits(Blocks.HOPPER, Blocks.HOPPER));
		assertTrue(Fills.providedFits(Blocks.CHEST, Blocks.CHEST));
		assertFalse(Fills.providedFits(Blocks.HOPPER, Blocks.DROPPER));
		assertFalse(Fills.providedFits(Blocks.HOPPER, Blocks.DISPENSER));
		assertFalse(Fills.providedFits(Blocks.HOPPER, Blocks.CHEST));
		assertFalse(Fills.providedFits(Blocks.DROPPER, Blocks.DROPPER)); // never, even declared (the placement refuses such an entry)
		assertFalse(Fills.providedFits(null, Blocks.HOPPER)); // no template: fail closed
	}

	@Test
	void aFillingSiteIsGuardedFromTheStart() throws Exception {
		// (FK-b fix) the reconcile at start runs at the START of the first server tick, before any level (a hopper) ticks
		String src = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/dev/larattalabs/architect/site/Builder.java"));
		assertTrue(src.contains("ServerTickEvents.START_SERVER_TICK.register(Builder::fillsAtStart)"), "the fill reconcile runs at START_SERVER_TICK");
		String guard = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/dev/larattalabs/architect/site/FillGuard.java"));
		assertFalse(guard.contains("Fills.filledSite("), "the guard asks guardedSite (FILLING counts), never filledSite alone");
	}

	@Test
	void aFillsCellsComeFromTheSitesOwnFootprintNeverTheLibraryHead() {
		// (FK-b fix, the release verification) v1 4x3x4 placed clockwise_90: its declared hopper (template 1,0,2) is at 101,66,101 from the
		// site's box and rotation alone, so a later head of another size (v2, depth 8: 105,66,101 by the head) can't move its guard
		dev.larattalabs.architect.placement.Anchors.Bounds box = new dev.larattalabs.architect.placement.Anchors.Bounds(100, 66, 100, 103, 68, 103);
		Site v1 = new Site("fkb-resize", "fkb_resize_absent_head", "clockwise_90", box, box, Map.of(), 0L, Site.OVERWORLD, box, Builder.JOURNAL_TARGET,
			null, null, null);
		assertEquals(new net.minecraft.core.BlockPos(101, 66, 101), Fills.world(v1, 1, 0, 2));
		// every rotation of a non-square template: the box's extents (swapped for odd turns) give the template's own size back
		String[] rot = {"none", "clockwise_90", "180", "counterclockwise_90"};
		for (int[] size : new int[][] {{4, 6}, {5, 3}, {7, 7}}) {
			for (int t = 0; t < 4; t++) {
				int ex = (t & 1) == 1 ? size[1] : size[0];
				int ez = (t & 1) == 1 ? size[0] : size[1];
				var b = new dev.larattalabs.architect.placement.Anchors.Bounds(10, 64, 20, 10 + ex - 1, 70, 20 + ez - 1);
				int turns = dev.larattalabs.architect.placement.BlueprintTransform.parseTurns(rot[t]);
				assertEquals(t, turns, rot[t]);
				for (int x = 0; x < size[0]; x++) {
					for (int z = 0; z < size[1]; z++) {
						int[] rc = dev.larattalabs.architect.placement.BlueprintTransform.rotateBlock(x, z, size[0], size[1], t);
						assertEquals(new net.minecraft.core.BlockPos(10 + rc[0], 65, 20 + rc[1]), Fills.world(b, rot[t], x, 1, z), size[0] + "x" + size[1] + " " + rot[t]);
					}
				}
			}
		}
	}
}
