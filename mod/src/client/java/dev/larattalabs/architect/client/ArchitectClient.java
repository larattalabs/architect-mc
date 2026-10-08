package dev.larattalabs.architect.client;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.hud.Toasts;
import dev.larattalabs.architect.client.launcher.Launcher;
import dev.larattalabs.architect.client.placement.PlacementFeature;
import dev.larattalabs.architect.client.screen.ScreenFeature;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
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
		dev.larattalabs.architect.client.dev.DeltaDev.init(); // phase 5b hooks (entry versions, deltas, revert, write counts)
		dev.larattalabs.architect.client.api.ApiClientBridge.init(); // the public API's client side (docs/CONTRACT.md phase 4a)
		Launcher.init();
		HudElementRegistry.addLast(Architect.id("hud/toasts"), dev.larattalabs.architect.client.ui.GuardedHud.of("hud.toasts", new Toasts()));
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
