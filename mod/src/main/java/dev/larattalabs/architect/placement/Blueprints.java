package dev.larattalabs.architect.placement;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.core.Vec3i;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.packs.resources.Resource;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * The design library (docs/CONTRACT.md "Library on disk"): bundled designs in the jar under
 * {@code data/architect_mc/library/<id>/} (through the server's resource manager, so data packs can add more), then the
 * user's library {@code <gameDir>/architect/library/<id>/}. Each folder holds {@code <id>.nbt} and
 * {@code <id>.blueprint.json} (plus optional source and previews). The same id in the user library overrides a bundled one.
 *
 * <p>Loaded when a server starts, on a data pack reload, on {@code /architect reload} and after a design finishes; cleared
 * when it stops. Broken designs are logged and skipped. Reads are safe from any thread.
 */
public final class Blueprints {
	public static final String RESOURCE_DIR = "library";
	public static final String SIDECAR_SUFFIX = ".blueprint.json";

	/**
	 * A loaded design: sidecar + template + where it came from ({@code bundled ...} / {@code user ...}).
	 *
	 * @param dir the user library folder it was read from, or null for a bundled one (previews come from the jar then)
	 */
	public record Entry(Blueprint blueprint, StructureTemplate template, String source, @Nullable Path dir) {
		public boolean bundled() {
			return dir == null;
		}
	}

	private static volatile Map<String, Entry> entries = Map.of();
	private static volatile List<String> lastProblems = List.of();
	private static volatile long revision;

	private Blueprints() {
	}

	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(Blueprints::reload);
		ServerLifecycleEvents.END_DATA_PACK_RELOAD.register((server, rm, ok) -> {
			if (ok) {
				reload(server);
			}
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			entries = Map.of();
			revision++;
		});
	}

	public static @Nullable Blueprint get(String id) {
		Entry e = entries.get(id);
		return e == null ? null : e.blueprint();
	}

	public static @Nullable Entry entry(String id) {
		return entries.get(id);
	}

	public static @Nullable StructureTemplate template(String id) {
		Entry e = entries.get(id);
		return e == null ? null : e.template();
	}

	/** All designs, sorted by id. */
	public static Collection<Blueprint> all() {
		return entries.values().stream().map(Entry::blueprint).toList();
	}

	public static Collection<Entry> entries() {
		return entries.values();
	}

	public static Collection<String> ids() {
		return entries.keySet();
	}

	/** Changes with every reload (the library tab refreshes its list when it does). */
	public static long revision() {
		return revision;
	}

	/** Problems found by the last load (one line each), for the reload command's feedback. */
	public static List<String> lastProblems() {
		return lastProblems;
	}

	/** {@code <gameDir>/architect}. */
	public static Path gameDataDir() {
		return FabricLoader.getInstance().getGameDir().resolve("architect");
	}

	/** {@code <gameDir>/architect/library}. */
	public static Path userDir() {
		return gameDataDir().resolve(RESOURCE_DIR);
	}

	/** Reloads everything. Call on the server thread. */
	public static synchronized void reload(MinecraftServer server) {
		Map<String, Entry> map = new TreeMap<>();
		List<String> problems = new ArrayList<>();
		loadBundled(server, map, problems);
		loadUser(server, map, problems);
		entries = Collections.unmodifiableMap(map);
		lastProblems = List.copyOf(problems);
		revision++;
		Architect.LOGGER.info("Library: {} design(s) loaded {}{}", map.size(), map.keySet(), problems.isEmpty() ? "" : ", " + problems.size() + " problem(s)");
	}

	private static void loadBundled(MinecraftServer server, Map<String, Entry> map, List<String> problems) {
		Map<Identifier, Resource> found = server.getResourceManager().listResources(RESOURCE_DIR, id -> id.getPath().endsWith(SIDECAR_SUFFIX));
		for (var e : found.entrySet()) {
			Identifier file = e.getKey();
			String where = file.toString();
			try (Reader r = new InputStreamReader(e.getValue().open(), StandardCharsets.UTF_8)) {
				Blueprint bp = Blueprint.fromJson(JsonParser.parseReader(r).getAsJsonObject());
				String expected = RESOURCE_DIR + "/" + bp.id() + "/" + bp.id() + SIDECAR_SUFFIX;
				if (!file.getPath().equals(expected)) {
					throw new IllegalArgumentException("expected at " + expected + " for id " + bp.id());
				}
				Identifier nbtId = Identifier.fromNamespaceAndPath(file.getNamespace(), RESOURCE_DIR + "/" + bp.id() + "/" + bp.id() + ".nbt");
				Resource nbt = server.getResourceManager().getResource(nbtId).orElseThrow(() -> new IllegalArgumentException("no template " + nbtId));
				StructureTemplate t;
				try (InputStream in = nbt.open()) {
					t = readTemplate(server, NbtIo.readCompressed(in, NbtAccounter.unlimitedHeap()));
				}
				accept(map, bp, t, "bundled " + where, null);
			} catch (Exception ex) {
				problem(problems, where, ex);
			}
		}
	}

	private static void loadUser(MinecraftServer server, Map<String, Entry> map, List<String> problems) {
		Path dir = userDir();
		if (!Files.isDirectory(dir)) {
			return;
		}
		List<Path> folders;
		try (Stream<Path> s = Files.list(dir)) {
			folders = s.filter(Files::isDirectory).sorted().toList();
		} catch (IOException e) {
			problem(problems, dir.toString(), e);
			return;
		}
		for (Path folder : folders) {
			String id = folder.getFileName().toString();
			if (!Blueprint.ID.matcher(id).matches()) {
				continue; // scratch folders, .DS_Store and the like
			}
			Path sidecar = folder.resolve(id + SIDECAR_SUFFIX);
			try {
				if (!Files.exists(sidecar)) {
					throw new IllegalArgumentException("no " + sidecar.getFileName());
				}
				Blueprint bp = Blueprint.fromJson(JsonParser.parseString(Files.readString(sidecar, StandardCharsets.UTF_8)).getAsJsonObject());
				if (!id.equals(bp.id())) {
					throw new IllegalArgumentException("folder " + id + " does not match id " + bp.id());
				}
				Path nbt = folder.resolve(id + ".nbt");
				if (!Files.exists(nbt)) {
					throw new IllegalArgumentException("no template " + nbt.getFileName());
				}
				accept(map, bp, readTemplate(server, NbtIo.readCompressed(nbt, NbtAccounter.unlimitedHeap())), "user " + folder, folder);
			} catch (Exception ex) {
				problem(problems, sidecar.toString(), ex);
			}
		}
	}

	/** A structure template tag, upgraded to the running game version. */
	public static StructureTemplate readTemplate(MinecraftServer server, CompoundTag tag) {
		int version = NbtUtils.getDataVersion(tag, 500);
		tag = DataFixTypes.STRUCTURE.updateToCurrentVersion(server.getFixerUpper(), tag, version);
		StructureTemplate t = new StructureTemplate();
		t.load(server.registryAccess().lookupOrThrow(Registries.BLOCK), tag);
		return t;
	}

	private static void accept(Map<String, Entry> map, Blueprint bp, StructureTemplate t, String source, @Nullable Path dir) {
		Vec3i size = t.getSize();
		if (size.getX() != bp.sizeX() || size.getY() != bp.sizeY() || size.getZ() != bp.sizeZ()) {
			throw new IllegalArgumentException("sidecar size " + bp.sizeX() + "x" + bp.sizeY() + "x" + bp.sizeZ() + " does not match template "
				+ size.getX() + "x" + size.getY() + "x" + size.getZ());
		}
		for (String w : bp.warnings()) {
			Architect.LOGGER.warn("Design {}: {}", bp.id(), w);
		}
		Entry old = map.put(bp.id(), new Entry(bp, t, source, dir));
		if (old != null) {
			Architect.LOGGER.info("Design {} from {} overrides {}", bp.id(), source, old.source());
		}
	}

	private static void problem(List<String> problems, String where, Exception e) {
		String msg = where + ": " + (e.getMessage() == null ? e.toString() : e.getMessage());
		problems.add(msg);
		Architect.LOGGER.warn("Skipping design {}", msg);
	}
}
