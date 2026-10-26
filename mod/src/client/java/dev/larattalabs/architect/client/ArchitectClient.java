package dev.larattalabs.architect.client;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.labui.client.hud.Toasts;
import dev.larattalabs.architect.client.launcher.Launcher;
import dev.larattalabs.architect.client.placement.PlacementFeature;
import dev.larattalabs.architect.client.screen.ScreenFeature;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.sounds.SoundSource;

/** Client entrypoint: dev-run auto world and mute, the DevBridge, placement, the Architect screen, designs and the launcher. */
public class ArchitectClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		AutoWorld.init();
		PlacementFeature.init();
		dev.larattalabs.architect.client.placement.RoadCellsClient.init(); // phase 4e: road cells for the ghost's approach
		dev.larattalabs.architect.client.placement.CompositePreview.init();
		ScreenFeature.init();
		DesignFeature.init();
		dev.larattalabs.architect.client.design.MassingReview.init();
		dev.larattalabs.architect.client.design.SetFeature.init();
		dev.larattalabs.architect.client.library.LibraryFeature.init();
		dev.larattalabs.architect.client.survival.SurvivalFeature.init();
		dev.larattalabs.architect.client.dev.JournalDev.init(); // phase 4e hooks (journal, roads, cell sites, region hashes)
		dev.larattalabs.architect.client.dev.RegionDev.init(); // phase 6a hooks (regions, prepare, hashes, counters, traces)
		dev.larattalabs.architect.client.dev.DeltaDev.init(); // phase 5b hooks (entry versions, deltas, revert, write counts)
		dev.larattalabs.architect.client.placement.DeltaGhost.init(); // phase 5b: the delta ghost (architect_mc:delta_preview)
		dev.larattalabs.architect.client.placement.RegionGhost.init(); // phase 6b: the region ghost (preview tiles, verdict line)
		dev.larattalabs.architect.client.dev.RegionDev6b.init(); // phase 6b hooks (check, previews, design, nudge, volumes, ghost, dumps)
		dev.larattalabs.architect.client.dev.Slice0aDev.init(); // phase 6c slice 0a hooks (skipSave, dropAck)
		dev.larattalabs.architect.client.dev.SliceVDev.init(); // phase 6c slice V hooks (dev.nav.villager)
		dev.larattalabs.architect.client.dev.SliceWDev.init(); // phase 6c slice W hooks (dev.region.survey)
		dev.larattalabs.architect.client.dev.SliceF2Dev.init(); // phase 6c slice F2 hooks (dev.feature.stamp)
		dev.larattalabs.architect.client.dev.SliceBDev.init(); // phase 6c slice B hooks (dev.brush)
		dev.larattalabs.architect.client.dev.SliceP0Dev.init(); // phase 6c slice P0 hooks (dev.region.checkPlan, realiseApproved, artifacts)
		dev.larattalabs.architect.client.dev.SlicePTDev.init(); // phase 6c slice PT hooks (dev.pt.*)
		dev.larattalabs.architect.client.dev.SlicePT2Dev.init(); // phase 6c slice PT2 hooks (dev.pt2.*)
		dev.larattalabs.architect.client.dev.SliceT3Dev.init(); // phase 6c slice T3a hooks (dev.t3.boat)
		dev.larattalabs.architect.client.dev.SliceClDev.init(); // phase 7a slice CL hooks (dev.climb)
		dev.larattalabs.architect.client.dev.SliceHDev.init(); // phase 6c slice H hooks (dev.fluid.*, dev.entity.damage)
		dev.larattalabs.architect.client.dev.SliceVocDev.init(); // phase 6c slice VOC hooks (dev.vocab.*)
		dev.larattalabs.architect.client.dev.SliceCuDev.init(); // phase 6c slice CU hooks (dev.copper.use)
		dev.larattalabs.architect.client.dev.SliceRsDev.init(); // phase 6c slice RS hooks (dev.rs.*)
		dev.larattalabs.architect.client.dev.SliceFlDev.init(); // phase 6c slice FL hooks (dev.region.items)
		dev.larattalabs.architect.client.dev.SliceVocbDev.init(); // phase 6c slice VOC-b hooks (dev.vocab.bibleRequest, dev.vocab.bibleJob)
		dev.larattalabs.architect.client.dev.SliceU1Dev.init(); // Style unification U1 hooks (dev.style.design, designState, variant, save, get)
		dev.larattalabs.architect.client.dev.SliceVoccDev.init(); // phase 6c slice VOC-c hooks (dev.vocc.checkPalette, histogram, regionPalette, delta)
		dev.larattalabs.architect.client.dev.SliceCoaDev.init(); // 6c close-out A hooks (dev.coa.*: keyed pins, discardPlan, plan files, the clock, the sweeps)
		dev.larattalabs.architect.client.dev.StockpileDev.init(); // phase 6c slice Y1 hooks (dev.stockpile.*)
		dev.larattalabs.architect.client.dev.SliceUi2bDev.init(); // slice UI-2b hooks (dev.ui2b.*, dev.gui.scale)
		dev.larattalabs.architect.client.dev.SliceUi03Dev.init(); // slice UI-0.3 hooks (dev.hud.zones, dev.ui03.*)
		dev.larattalabs.architect.client.dev.SliceSafetyDev.init(); // slice SAFETY hooks (dev.safety.*)
		dev.larattalabs.architect.client.screen.U3Dev.init(); // Style unification U3 hooks (dev.u3.*)
		dev.larattalabs.architect.client.api.ApiClientBridge.init(); // the public API's client side (docs/CONTRACT.md phase 4a)
		Launcher.init();
		Toasts.install(); // lab-ui's one shared toast stack (never also register new Toasts(): it would draw every toast twice)
		// UI-0.3: no Toasts.avoid: the placement, plot and massing panels are BOTTOM_CENTER zone pieces, laid out before the toast
		// column, which ends above them (lab-ui HudLayout)
		ClientLifecycleEvents.CLIENT_STARTED.register(ArchitectClient::onStarted);
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> DevBridge.stopBridge());
		Architect.LOGGER.info("Architect client init (devPort={}, mute={}, takeFocus={}, autoWorld={})", ClientEnv.DEV_PORT, ClientEnv.MUTE,
			ClientEnv.TAKE_FOCUS, ClientEnv.AUTO_WORLD);
	}

	private static void onStarted(Minecraft mc) {
		if (ClientEnv.MUTE) {
			mc.options.getSoundSourceOptionInstance(SoundSource.MASTER).set(0.0);
			mc.options.getSoundSourceOptionInstance(SoundSource.MUSIC).set(0.0);
			Architect.LOGGER.info("Muted (ARCHITECT_MUTE=1; set ARCHITECT_MUTE=0 to keep your volume)");
		}
		if (ClientEnv.DEV_RUN) {
			mc.options.pauseOnLostFocus = false;
		}
		DevBridge.startBridge();
	}
}
