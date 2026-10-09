package dev.larattalabs.architect.region;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;

/** Vanilla's registries, once per JVM (block states in region tests). */
final class Boot {
	private static boolean booted;

	private Boot() {
	}

	static synchronized void boot() {
		if (!booted) {
			SharedConstants.tryDetectVersion();
			Bootstrap.bootStrap();
			booted = true;
		}
	}
}
