package dev.larattalabs.architect.api;

import java.util.Set;
import net.minecraft.server.MinecraftServer;

/**
 * Architect's public API (docs/CONTRACT.md "Phase 4a contract: public API"). Everything in {@code dev.larattalabs.architect.api}
 * is the contract and follows {@link #VERSION} (semver: a minor bump adds methods, a major bump breaks); everything else in
 * Architect is internal and may change without notice.
 *
 * <p>Entry: {@link #get()}. All calls are on the server thread unless noted; async results are {@code CompletableFuture}s
 * completed on the server thread. A dependent mod declares {@code "depends": {"architect_mc": ">=0.4.0"}} and checks
 * {@link #VERSION} at runtime when it needs a newer minor version.
 */
public interface ArchitectApi {
	String VERSION = "1.0.0";

	/** The singleton. Safe to call from any mod's initializer (it does not depend on Architect's init order). */
	static ArchitectApi get() {
		return dev.larattalabs.architect.apiimpl.ApiImpl.instance();
	}

	/** The design library (bundled + user): reads and a few writes. */
	Library library();

	/** The sites of the world {@code s} runs. */
	Sites sites(MinecraftServer s);

	/** Terrain sampling. */
	Survey survey();

	/** Fabric events (R7). The fields are static on {@link SiteEvents}, so registering before a world exists is fine. */
	SiteEvents events();

	/** Claude jobs (R2). Until the sidecar speaks protocol 2 this reports {@code available() == false}. */
	Jobs jobs();

	/** Building design requests (the Design tab's pipeline). */
	Designs designs();

	/**
	 * What this game can do: the sidecar's {@code features} (when the snapshot names any; {@code "protocol2"} when it chose
	 * protocol 2) plus Java-only ones ({@code "designs"}, {@code "survey"}, {@code "sites"}, {@code "events"}, ...). Any thread.
	 */
	Set<String> features();
}
