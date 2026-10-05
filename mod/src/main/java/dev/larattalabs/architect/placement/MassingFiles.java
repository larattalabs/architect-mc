package dev.larattalabs.architect.placement;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.core.Vec3i;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.util.datafix.DataFixers;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * Massings on disk (docs/CONTRACT.md "Phase 4c contract", sidecar/README.md "Phase 4c"): the sidecar installs each version at
 * {@code <gameDir>/architect/massings/<id>/versions/<v>/} ({@code <id>.nbt}, {@code <id>.blueprint.json}) and copies the
 * latest to {@code <gameDir>/architect/massings/<id>/}. Massings never enter the library; this reads one as a
 * {@link Blueprints.Entry} (for the composite preview) without a server: the template is upgraded with the game's data
 * fixer and read against the built-in block registry. Any thread.
 */
public final class MassingFiles {
	/** A massing reference: {@code <id>} (its latest version) or {@code <id>@<version>}. */
	public static final Pattern REF = Pattern.compile("([a-z0-9_]{1,64})(?:@(\\d{1,6}))?");

	private MassingFiles() {
	}

	/** {@code <gameDir>/architect/massings}. */
	public static Path root() {
		return Blueprints.gameDataDir().resolve("massings");
	}

	/** The folder of a reference ({@code id} or {@code id@v}), or null when it is not a massing reference. */
	public static @Nullable Path dir(Path root, String ref) {
		Matcher m = REF.matcher(ref);
		if (!m.matches()) {
			return null;
		}
		Path d = root.resolve(m.group(1));
		return m.group(2) == null ? d : d.resolve("versions").resolve(Integer.toString(Integer.parseInt(m.group(2))));
	}

	/** The id part of a reference. */
	public static String id(String ref) {
		int at = ref.indexOf('@');
		return at < 0 ? ref : ref.substring(0, at);
	}

	/** Whether the massing (version) is installed: its template and its blueprint JSON exist. */
	public static boolean exists(String ref) {
		Path d = dir(root(), ref);
		return d != null && Files.isRegularFile(d.resolve(id(ref) + ".nbt")) && Files.isRegularFile(d.resolve(id(ref) + Blueprints.SIDECAR_SUFFIX));
	}

	/** Reads an installed massing (version) as a library-like entry (not added to the library). */
	public static Blueprints.Entry read(String ref) throws IOException {
		Path d = dir(root(), ref);
		if (d == null) {
			throw new IOException("not a massing id: " + ref);
		}
		String id = id(ref);
		JsonObject json = JsonParser.parseString(Files.readString(d.resolve(id + Blueprints.SIDECAR_SUFFIX), StandardCharsets.UTF_8)).getAsJsonObject();
		Blueprint bp = Blueprint.fromJson(json);
		CompoundTag tag = NbtIo.readCompressed(d.resolve(id + ".nbt"), NbtAccounter.unlimitedHeap());
		int version = NbtUtils.getDataVersion(tag, 500);
		tag = DataFixTypes.STRUCTURE.updateToCurrentVersion(DataFixers.getDataFixer(), tag, version);
		StructureTemplate t = new StructureTemplate();
		t.load(BuiltInRegistries.BLOCK, tag);
		Vec3i size = t.getSize();
		if (size.getX() != bp.sizeX() || size.getY() != bp.sizeY() || size.getZ() != bp.sizeZ()) {
			throw new IOException("massing " + ref + ": its JSON size does not match its template");
		}
		return new Blueprints.Entry(bp, t, "massing " + d, d, json);
	}
}
