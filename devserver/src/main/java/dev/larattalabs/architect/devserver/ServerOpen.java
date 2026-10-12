package dev.larattalabs.architect.devserver;

import com.mojang.authlib.services.MinecraftServicesDiscoveryService;
import com.mojang.serialization.Dynamic;
import dev.larattalabs.architect.Architect;
import java.io.File;
import java.lang.reflect.Method;
import java.net.Proxy;
import java.nio.file.Paths;
import java.util.Optional;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.Services;
import net.minecraft.server.WorldLoader;
import net.minecraft.server.WorldStem;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.server.dedicated.DedicatedServerProperties;
import net.minecraft.server.dedicated.DedicatedServerSettings;
import net.minecraft.server.jsonrpc.JsonRpc;
import net.minecraft.server.jsonrpc.ManagementServer;
import net.minecraft.server.notifications.NotificationManager;
import net.minecraft.server.packs.repository.PackRepository;
import net.minecraft.server.packs.repository.ServerPacksSource;
import net.minecraft.util.Util;
import net.minecraft.util.datafix.DataFixers;
import net.minecraft.util.worldupdate.UpgradeProgress;
import net.minecraft.world.level.chunk.storage.RegionFileVersion;
import net.minecraft.world.level.dimension.LevelStem;
import net.minecraft.world.level.storage.LevelDataAndDimensions;
import net.minecraft.world.level.storage.LevelStorageSource;
import net.minecraft.world.level.storage.LevelSummary;

/**
 * The dedicated server's {@code Main.main} after the first world, for a world switch in this process (the way a client starts
 * a new integrated server per world): server.properties, the level storage, the data packs and world stem, then
 * {@code MinecraftServer.spin} with a new {@link DedicatedServer}. Not {@code Main.main} itself: Fabric runs the mods'
 * initializers from there, once per process. What the first start did once (bootstrap, the EULA check, the timer thread, the
 * shutdown hook) is not repeated. The two helpers Main keeps private are called by reflection.
 */
final class ServerOpen {
	private ServerOpen() {
	}

	static void open(String levelName) throws Exception {
		DedicatedServerSettings settings = new DedicatedServerSettings(Paths.get("server.properties"));
		settings.forceSave();
		RegionFileVersion.configure(settings.getProperties().regionFileComression);
		File universePath = new File("saves");
		Services services = Services.create(MinecraftServicesDiscoveryService.create(Proxy.NO_PROXY), universePath);
		NotificationManager notificationManager = new NotificationManager();
		ManagementServer jsonRpcServer = JsonRpc.create(settings, notificationManager);
		LevelStorageSource levelStorageSource = LevelStorageSource.createDefault(universePath.toPath());
		LevelStorageSource.LevelStorageAccess access = levelStorageSource.validateAndCreateAccess(levelName);
		Dynamic<?> levelDataTag;
		if (access.hasWorldData()) {
			Dynamic<?> unfixed = access.getUnfixedDataTagWithFallback();
			LevelSummary summary = access.fixAndGetSummaryFromTag(unfixed);
			if (summary.requiresManualConversion() || !summary.isCompatible()) {
				throw new IllegalStateException("world " + levelName + " needs conversion or is incompatible");
			}
			levelDataTag = DataFixers.getFileFixer().fix(access, unfixed, new UpgradeProgress(notificationManager));
		} else {
			levelDataTag = null;
		}
		PackRepository packRepository = ServerPacksSource.createPackRepository(access);
		Method loadOrCreateConfig = net.minecraft.server.Main.class.getDeclaredMethod("loadOrCreateConfig", DedicatedServerProperties.class, Dynamic.class,
			boolean.class, PackRepository.class);
		loadOrCreateConfig.setAccessible(true);
		Method createNewWorldData = net.minecraft.server.Main.class.getDeclaredMethod("createNewWorldData", DedicatedServerSettings.class,
			WorldLoader.DataLoadContext.class, Registry.class, boolean.class, boolean.class);
		createNewWorldData.setAccessible(true);
		WorldLoader.InitConfig initConfig = (WorldLoader.InitConfig) loadOrCreateConfig.invoke(null, settings.getProperties(), levelDataTag, false,
			packRepository);
		final Dynamic<?> tag = levelDataTag;
		WorldStem worldStem = Util.blockUntilDone(executor -> WorldLoader.load(initConfig, context -> {
			Registry<LevelStem> datapackDimensions = context.datapackDimensions().lookupOrThrow(Registries.LEVEL_STEM);
			if (tag != null) {
				LevelDataAndDimensions worldData = LevelStorageSource.getLevelDataAndDimensions(access, tag, context.dataConfiguration(), datapackDimensions,
					context.datapackWorldRegistries());
				return new WorldLoader.DataLoadOutput<>(worldData.worldDataAndGenSettings(), worldData.dimensions().dimensionsRegistryAccess());
			}
			Architect.LOGGER.info("devserver: no existing world data, creating {}", levelName);
			try {
				@SuppressWarnings("unchecked")
				WorldLoader.DataLoadOutput<LevelDataAndDimensions.WorldDataAndGenSettings> out = (WorldLoader.DataLoadOutput<LevelDataAndDimensions.WorldDataAndGenSettings>)
					createNewWorldData.invoke(null, settings, context, datapackDimensions, false, false);
				return out;
			} catch (ReflectiveOperationException e) {
				throw new IllegalStateException(e);
			}
		}, WorldStem::new, Util.backgroundExecutor(), executor)).get();
		access.saveDataTag(worldStem.worldDataAndGenSettings().data());
		MinecraftServer.spin(thread -> {
			DedicatedServer server = new DedicatedServer(thread, access, packRepository, worldStem, Optional.empty(), settings, DataFixers.getDataFixer(), services,
				jsonRpcServer, notificationManager);
			notificationManager.setServer(server);
			server.setPort(-1);
			return server;
		});
	}
}
