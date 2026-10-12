package dev.larattalabs.architect.survival;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.site.Builder;
import java.util.Set;
import net.fabricmc.fabric.api.event.player.AttackBlockCallback;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.MapColor;
import net.minecraft.world.level.material.PushReaction;

/** Registers the construction crate (block + block entity) and keeps players from breaking it (docs/CONTRACT.md phase 3). */
public final class CrateBlocks {
	public static final ResourceKey<Block> CRATE_KEY = ResourceKey.create(Registries.BLOCK, Architect.id("construction_crate"));
	public static final Block CRATE = Registry.register(BuiltInRegistries.BLOCK, CRATE_KEY,
		new CrateBlock(BlockBehaviour.Properties.of().setId(CRATE_KEY).mapColor(MapColor.WOOD).strength(-1.0f, 3_600_000.0f).noLootTable()
			.sound(SoundType.WOOD).pushReaction(PushReaction.IMMOVEABLE)));
	public static final BlockEntityType<CrateBlockEntity> CRATE_ENTITY = Registry.register(BuiltInRegistries.BLOCK_ENTITY_TYPE,
		Architect.id("construction_crate"), new BlockEntityType<>(CrateBlockEntity::new, Set.of(CRATE)));

	private CrateBlocks() {
	}

	public static final String USE_DECONSTRUCT = "The construction crate can't be broken while its site builds: open it and use Deconstruct";
	/** 6c Y (C24): a stockpile crate. */
	public static final String USE_REMOVECRATE = "A stockpile crate can't be broken: remove it with /architect stockpile removecrate or through its owner";

	public static void init() {
		// strength -1 already stops survival mining; creative players break anything instantly, so refuse it here
		PlayerBlockBreakEvents.BEFORE.register((level, player, pos, state, be) -> {
			if (!state.is(CRATE)) {
				return true;
			}
			if (be instanceof CrateBlockEntity crate && crate.siteId().startsWith(dev.larattalabs.architect.site.Stockpiles.PREFIX)) {
				// 6c Y: a stockpile crate is never broken by hand (the ledger is the owner's; the block goes through its owner)
				if (!level.isClientSide()) {
					player.sendOverlayMessage(Component.literal(USE_REMOVECRATE));
				}
				return false;
			}
			if (!level.isClientSide() && be instanceof CrateBlockEntity crate && Builder.siteBuilding(crate.siteId())) {
				player.sendOverlayMessage(Component.literal(USE_DECONSTRUCT));
				return false;
			}
			return !Builder.siteBuilding(be instanceof CrateBlockEntity c ? c.siteId() : "");
		});
		AttackBlockCallback.EVENT.register((player, level, hand, pos, dir) -> {
			if (!level.isClientSide() && level.getBlockState(pos).is(CRATE)) {
				boolean pile = level.getBlockEntity(pos) instanceof CrateBlockEntity c && c.siteId().startsWith(dev.larattalabs.architect.site.Stockpiles.PREFIX);
				player.sendOverlayMessage(Component.literal(pile ? USE_REMOVECRATE : USE_DECONSTRUCT));
			}
			return InteractionResult.PASS;
		});
		Architect.LOGGER.debug("Registered {}", CRATE_KEY.identifier());
	}
}
