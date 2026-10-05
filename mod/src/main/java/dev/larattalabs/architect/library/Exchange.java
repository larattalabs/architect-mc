package dev.larattalabs.architect.library;

import dev.larattalabs.architect.placement.Blueprint;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;
import org.jspecify.annotations.Nullable;

/**
 * Export / import paths (docs/CONTRACT.md "Import / export"). Pure (NIO only).
 *
 * <ul>
 * <li>Export: {@code <gameDir>/architect/exports/<id>/<id>.nbt + <id>.blueprint.json}, and the template copied into the current
 * world as {@code <world>/generated/architect_mc/structure/<id>.nbt}, which a vanilla structure block loads as
 * {@code architect_mc:<id>}. Minecraft 26.3 keeps structure-block saves in {@code generated/<namespace>/structure/}
 * (singular: {@code StructureTemplateManager.WORLD_STRUCTURE_LISTER}); older versions used {@code structures/}.</li>
 * <li>Import: the {@code .nbt} files in {@code <gameDir>/architect/imports/} and in the world's {@code generated/<ns>/structure/}
 * (and the legacy {@code structures/}), walked recursively.</li>
 * </ul>
 */
public final class Exchange {
	public static final String NAMESPACE = "architect_mc";
	/** 26.3: {@code StructureTemplateManager.STRUCTURE_DIRECTORY_NAME}. */
	public static final String STRUCTURE_DIR = "structure";
	public static final String LEGACY_STRUCTURE_DIR = "structures";
	public static final int MAX_IMPORT_LIST = 200;

	private Exchange() {
	}

	/** {@code <gameData>/exports/<id>}. */
	public static Path exportDir(Path gameData, String id) {
		check(id);
		return gameData.resolve("exports").resolve(id);
	}

	/** {@code <gameData>/imports}. */
	public static Path importsDir(Path gameData) {
		return gameData.resolve("imports");
	}

	/** {@code <world>/generated/<namespace>/structure/<id>.nbt}. */
	public static Path worldStructure(Path worldRoot, String namespace, String id) {
		check(id);
		return worldRoot.resolve("generated").resolve(namespace).resolve(STRUCTURE_DIR).resolve(id + ".nbt");
	}

	private static void check(String id) {
		if (!Blueprint.ID.matcher(id).matches()) {
			throw new IllegalArgumentException("not a library id: " + id);
		}
	}

	/**
	 * One importable file.
	 *
	 * @param where {@code imports}, {@code exports} or {@code world}
	 * @param structureId for a world file, the structure-block name ({@code ns:path}), else null
	 */
	public record Candidate(Path path, String where, String label, @Nullable String structureId, long modified, long bytes) {
	}

	/**
	 * The {@code .nbt} files to offer: {@code imports/} first, then {@code exports/}, then the world's structure-block saves; each group newest
	 * first; at most {@value #MAX_IMPORT_LIST}. {@code worldRoot} may be null (not in a world).
	 */
	public static List<Candidate> importCandidates(Path gameData, @Nullable Path worldRoot) throws IOException {
		List<Candidate> out = new ArrayList<>();
		Path imports = importsDir(gameData);
		if (Files.isDirectory(imports)) {
			List<Candidate> group = new ArrayList<>();
			for (Path p : nbtFiles(imports)) {
				group.add(candidate(p, "imports", imports.relativize(p).toString().replace('\\', '/'), null));
			}
			group.sort(Comparator.comparingLong(Candidate::modified).reversed());
			out.addAll(group);
		}
		// exports (from any world): an export can be imported in another world without copying files by hand
		Path exports = gameData.resolve("exports");
		if (Files.isDirectory(exports)) {
			List<Candidate> group = new ArrayList<>();
			for (Path p : nbtFiles(exports)) {
				group.add(candidate(p, "exports", exports.relativize(p).toString().replace('\\', '/'), null));
			}
			group.sort(Comparator.comparingLong(Candidate::modified).reversed());
			out.addAll(group);
		}
		Path generated = worldRoot == null ? null : worldRoot.resolve("generated");
		if (generated != null && Files.isDirectory(generated)) {
			List<Candidate> group = new ArrayList<>();
			List<Path> namespaces;
			try (Stream<Path> s = Files.list(generated)) {
				namespaces = s.filter(Files::isDirectory).sorted().toList();
			}
			for (Path ns : namespaces) {
				for (String dir : List.of(STRUCTURE_DIR, LEGACY_STRUCTURE_DIR)) {
					Path root = ns.resolve(dir);
					if (!Files.isDirectory(root)) {
						continue;
					}
					for (Path p : nbtFiles(root)) {
						String rel = root.relativize(p).toString().replace('\\', '/');
						String sid = ns.getFileName() + ":" + rel.substring(0, rel.length() - ".nbt".length());
						group.add(candidate(p, "world", sid, sid));
					}
				}
			}
			group.sort(Comparator.comparingLong(Candidate::modified).reversed());
			out.addAll(group);
		}
		return out.size() > MAX_IMPORT_LIST ? List.copyOf(out.subList(0, MAX_IMPORT_LIST)) : out;
	}

	private static List<Path> nbtFiles(Path root) throws IOException {
		try (Stream<Path> s = Files.walk(root, 8)) {
			return s.filter(p -> Files.isRegularFile(p) && p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".nbt")).sorted().toList();
		}
	}

	private static Candidate candidate(Path p, String where, String label, @Nullable String sid) throws IOException {
		return new Candidate(p, where, label, sid, Files.getLastModifiedTime(p).toMillis(), Files.size(p));
	}

	/** A library id suggested for a file name ({@code "My House.nbt"} -> {@code my_house}). */
	public static String suggestId(String fileName) {
		String base = fileName.replaceAll("(?i)\\.nbt$", "");
		int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf(':'));
		base = base.substring(slash + 1);
		String s = base.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "_").replaceAll("^_+|_+$", "");
		return s.isEmpty() ? "imported" : s;
	}
}
