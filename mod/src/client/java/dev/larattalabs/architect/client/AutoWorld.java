package dev.larattalabs.architect.client;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.world.AutoWorldSpec;
import java.util.List;
import java.util.Optional;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.Minecraft;
import dev.larattalabs.architect.client.mixin.BackupConfirmScreenAccessor;
import net.minecraft.client.gui.screens.AccessibilityOnboardingScreen;
import net.minecraft.client.gui.screens.BackupConfirmScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.HolderSet;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.levelgen.FlatLevelSource;
import net.minecraft.world.level.levelgen.WorldDimensions;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.flat.FlatLayerInfo;
import net.minecraft.world.level.levelgen.flat.FlatLevelGeneratorSettings;
import net.minecraft.world.level.levelgen.presets.WorldPresets;

/**
 * Dev runs only (ARCHITECT_AUTOWORLD, default on in gradlew runClient, off for an installed jar): boots straight into
 * the "Architect Dev" world without any clicks: the first time the title screen appears, the world is loaded if it exists,
 * or created (creative, peaceful, natural terrain with seed 2026 by default, so placement meets slopes) if it does not. Disable with ARCHITECT_AUTOWORLD=0.
 * ARCHITECT_AUTOWORLD_NAME / _PRESET (flat | normal) / _SEED / _MODE (creative | survival | hardcore) / _CHEATS pick another world ({@link AutoWorldSpec});
 */
public final class AutoWorld {
	private static boolean attempted;
	/** True while AutoWorld itself is opening its world (so its confirm screens may be auto-answered). */
	private static boolean openingHq;

	private AutoWorld() {
	}

	public static void init() {
		if (!ClientEnv.AUTO_WORLD) {
			Architect.LOGGER.info("AutoWorld disabled (ARCHITECT_AUTOWORLD=0)");
			return;
		}
		ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> openingHq = false);
		ScreenEvents.AFTER_INIT.register((client, screen, w, h) -> {
			if (openingHq && screen instanceof BackupConfirmScreen backup) {
				// Registry content changed since the HQ world was saved (a block/entity was renamed or removed
				// while developing). The HQ world is generated, so take Fabric's backup and load it instead of
				// waiting forever on "Missing content detected!" in an unattended run.
				openingHq = false;
				Architect.LOGGER.warn("AutoWorld: '{}' needs confirmation ({}); making a backup and loading it",
					spec == null ? "?" : spec.name(), screen.getTitle().getString());
				client.execute(() -> ((BackupConfirmScreenAccessor) backup).architect$onProceed().proceed(true, false));
				return;
			}
			if (attempted) {
				return;
			}
			if (screen instanceof TitleScreen || screen instanceof AccessibilityOnboardingScreen) {
				attempted = true;
				// Never switch screens from inside another screen's init.
				client.execute(() -> openOrCreate(client));
			}
		});
	}

	private static AutoWorldSpec spec;

	public static void openOrCreate(Minecraft mc) {
		openOrCreate(mc, java.util.Map.of());
	}

	/**
	 * Opens (or creates) the AutoWorld world, with {@code overrides} taking the place of the environment's
	 * {@code ARCHITECT_AUTOWORLD_*} values (DevBridge {@code dev.world.open {name, mode, preset, seed, cheats}}).
	 */
	public static void openOrCreate(Minecraft mc, java.util.Map<String, String> overrides) {
		try {
			spec = AutoWorldSpec.from(k -> overrides.containsKey(k) ? overrides.get(k) : ClientEnv.raw(k));
			String name = spec.name();
			if (mc.getLevelSource().levelExists(name)) {
				Architect.LOGGER.info("AutoWorld: loading existing world '{}'", name);
				openingHq = true;
				mc.createWorldOpenFlows().openWorld(name, () -> mc.gui.setScreen(new TitleScreen()));
			} else {
				Architect.LOGGER.info("AutoWorld: creating world '{}' ({}, seed {}, {}, cheats {})", name, spec.preset(), spec.seed(), spec.mode(),
					spec.cheats() ? "on" : "off");
				boolean hardcore = spec.mode() == AutoWorldSpec.Mode.HARDCORE;
				LevelSettings settings = new LevelSettings(
					name,
					spec.mode() == AutoWorldSpec.Mode.CREATIVE ? GameType.CREATIVE : GameType.SURVIVAL,
					// hardcore is always hard; survival dev worlds stay peaceful so mobs never disturb a check
					new LevelSettings.DifficultySettings(hardcore ? Difficulty.HARD : Difficulty.PEACEFUL, hardcore, false),
					spec.cheats(),
					WorldDataConfiguration.DEFAULT
				);
				WorldOptions options = new WorldOptions(spec.seed(), false, false);
				mc.createWorldOpenFlows().createFreshLevel(name, settings, options,
					spec.preset() == AutoWorldSpec.Preset.FLAT ? AutoWorld::meadowDimensions : WorldPresets::createNormalWorldDimensions,
					new TitleScreen());
			}
		} catch (Exception e) {
			Architect.LOGGER.error("AutoWorld failed; staying on the title screen", e);
			mc.gui.setScreen(new TitleScreen());
		}
	}

	/** Normal dimensions, with the overworld replaced by a flat plains meadow (grass top at y=64). */
	private static WorldDimensions meadowDimensions(HolderLookup.Provider registries) {
		Holder<Biome> plains = registries.lookupOrThrow(Registries.BIOME).getOrThrow(Biomes.PLAINS);
		FlatLevelGeneratorSettings base = new FlatLevelGeneratorSettings(Optional.of(HolderSet.empty()), plains, List.of());
		// y=-64 bedrock, stone up to 60, dirt 61..63, grass 64.
		List<FlatLayerInfo> layers = List.of(
			new FlatLayerInfo(1, Blocks.BEDROCK),
			new FlatLayerInfo(124, Blocks.STONE),
			new FlatLayerInfo(3, Blocks.DIRT),
			new FlatLayerInfo(1, Blocks.GRASS_BLOCK)
		);
		FlatLevelGeneratorSettings flat = base.withBiomeAndLayers(layers, Optional.of(HolderSet.empty()), plains);
		return WorldPresets.createNormalWorldDimensions(registries).replaceOverworldGenerator(registries, new FlatLevelSource(flat));
	}
}
