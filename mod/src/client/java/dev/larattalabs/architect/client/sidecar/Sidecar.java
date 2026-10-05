package dev.larattalabs.architect.client.sidecar;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.ClientEnv;
import dev.larattalabs.architect.launcher.LauncherPlan;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import org.jspecify.annotations.Nullable;

/**
 * The sidecar connection of the running client (docs/CONTRACT.md "Protocol"): one {@link SidecarState} and one
 * {@link SidecarLink} to {@code ws://127.0.0.1:<ARCHITECT_PORT, 7890>}, and the client messages the screens send. The
 * {@code Launcher} starts the link once a sidecar runs (or is reused). Client thread unless noted.
 */
public final class Sidecar {
	private static final SidecarState STATE = new SidecarState();
	private static @Nullable SidecarLink link;

	private Sidecar() {
	}

	/** The sidecar port: {@code ARCHITECT_PORT} / {@code -Darchitect.port}, default 7890. */
	public static int port() {
		return ClientEnv.intValue("ARCHITECT_PORT", LauncherPlan.DEFAULT_PORT);
	}

	/** {@code <gameDir>/architect/sidecar-data}. */
	public static Path dataDir() {
		return Blueprints.gameDataDir().resolve("sidecar-data");
	}

	/** The client token the sidecar wrote ({@code <data>/client.token}), or null. Never log it. Any thread. */
	public static @Nullable String readToken() {
		try {
			String t = Files.readString(dataDir().resolve("client.token"), StandardCharsets.UTF_8).strip();
			return t.isEmpty() ? null : t;
		} catch (IOException e) {
			return null;
		}
	}

	public static synchronized void init() {
		if (link != null) {
			return;
		}
		String version = FabricLoader.getInstance().getModContainer(Architect.MOD_ID).map(c -> c.getMetadata().getVersion().getFriendlyString())
			.orElse("dev");
		link = new SidecarLink(URI.create("ws://127.0.0.1:" + port()), version, STATE, Minecraft.getInstance()::execute, Sidecar::readToken);
	}

	public static SidecarState state() {
		return STATE;
	}

	public static SidecarLink link() {
		init();
		return link;
	}

	public static boolean connected() {
		return link != null && link.status().synced();
	}

	private static JsonObject msg(String type) {
		JsonObject o = new JsonObject();
		o.addProperty("v", SidecarLink.PROTOCOL);
		o.addProperty("type", type);
		return o;
	}

	/** {@code design.request {request}}; the ack's result carries {@code designId}. */
	public static CompletableFuture<SidecarLink.Ack> designRequest(JsonObject request) {
		JsonObject m = msg("design.request");
		m.add("request", request);
		return link().send(m);
	}

	public static CompletableFuture<SidecarLink.Ack> designCancel(String designId) {
		JsonObject m = msg("design.cancel");
		m.addProperty("designId", designId);
		return link().send(m);
	}

	/**
	 * {@code auth.set}: {@code apiKey} (a string sets it, {@code ""} / null with {@code clearKey} clears it, null leaves it)
	 * and/or {@code useClaudeLogin}. The key is sent once and never logged, stored or echoed by the mod.
	 */
	public static CompletableFuture<SidecarLink.Ack> authSet(@Nullable String apiKey, boolean clearKey, @Nullable Boolean useClaudeLogin) {
		JsonObject m = msg("auth.set");
		if (apiKey != null && !apiKey.isBlank()) {
			m.addProperty("apiKey", apiKey.strip());
		} else if (clearKey) {
			m.add("apiKey", com.google.gson.JsonNull.INSTANCE);
		}
		if (useClaudeLogin != null) {
			m.addProperty("useClaudeLogin", useClaudeLogin);
		}
		return link().send(m);
	}

	/** {@code variant.request {from, palette?, values?, name?}}; the ack's result carries {@code variantId}. */
	public static CompletableFuture<SidecarLink.Ack> variantRequest(JsonObject payload) {
		JsonObject m = msg("variant.request");
		for (var e : payload.entrySet()) {
			m.add(e.getKey(), e.getValue());
		}
		return link().send(m);
	}

	/** {@code import.request {path}} (an absolute {@code .nbt} path); the ack's result carries the job id. */
	public static CompletableFuture<SidecarLink.Ack> importRequest(String path) {
		JsonObject m = msg("import.request");
		m.addProperty("path", path);
		return link().send(m);
	}

	/** {@code shutdown {}} (the launcher stops a sidecar it started). */
	public static CompletableFuture<SidecarLink.Ack> shutdown() {
		return link().send(msg("shutdown"));
	}
}
