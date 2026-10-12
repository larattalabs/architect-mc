package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.Reason;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import net.minecraft.commands.CommandSourceStack;

/**
 * The slice 6c SCH steps of apitest (docs/CONTRACT.md "Phase 6c slice SCH"): Sponge schematic import and export through
 * {@code dev.larattalabs.architect.api} only. Paths, names and JSON are base64 (UTF-8); {@code -} is null.
 */
public final class ApiTestSchem {
	private ApiTestSchem() {
	}

	private static String text(String s) {
		return s.equals("-") ? null : new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8);
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		switch (a[0]) {
			case "schemimport": {
				// schemimport <key> <b64 path> <b64 name|-> <b64 ext json|->
				String ext = text(a[4]);
				return ApiTest.later("schemimport:" + a[1], api.library().importSchematic(Path.of(text(a[2])), text(a[3]), ext == null ? null : JsonParser
					.parseString(ext).getAsJsonObject()).thenApply(ApiTestSchem::entry));
			}
			case "schemexport": {
				// schemexport <key> <entry> <version|-> <b64 dir>
				Integer v = a[3].equals("-") ? null : Integer.valueOf(a[3]);
				return ApiTest.later("schemexport:" + a[1], api.library().exportSchematic(a[2], v, Path.of(text(a[4]))).thenApply(ApiTestSchem::file));
			}
			case "schemsite": {
				// schemsite <key> <site> <b64 dir>
				return ApiTest.later("schemsite:" + a[1], api.sites(src.getServer()).exportSiteSchematic(a[2], Path.of(text(a[3]))).thenApply(ApiTestSchem::file));
			}
			case "apisch": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				o.addProperty("schematics", api.features().contains("schematics"));
				o.addProperty("formatAppended", Reason.FORMAT.ordinal() > Reason.FIELD_LIMIT.ordinal());
				return o;
			}
			default:
				return new JsonPrimitive("unknown step " + a[0]);
		}
	}

	static JsonObject entry(Library.Entry e) {
		JsonObject o = new JsonObject();
		o.addProperty("id", e.id());
		o.addProperty("name", e.name());
		o.addProperty("imported", e.imported());
		o.addProperty("groundY", e.groundY());
		JsonArray size = new JsonArray();
		size.add(e.size().x());
		size.add(e.size().y());
		size.add(e.size().z());
		o.add("size", size);
		JsonArray tags = new JsonArray();
		e.tags().forEach(tags::add);
		o.add("tags", tags);
		o.add("ext", e.ext());
		return o;
	}

	static JsonObject file(Path p) {
		JsonObject o = new JsonObject();
		o.addProperty("file", p.toAbsolutePath().toString());
		try {
			byte[] b = Files.readAllBytes(p);
			o.addProperty("bytes", b.length);
			o.addProperty("sha256", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b)));
		} catch (Exception e) {
			o.addProperty("error", e.toString());
		}
		return o;
	}
}
