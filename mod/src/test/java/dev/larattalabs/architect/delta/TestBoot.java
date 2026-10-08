package dev.larattalabs.architect.delta;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;

/** Vanilla's registries, once per JVM, before any class with block constants is touched. */
final class TestBoot {
	private static boolean booted;

	private TestBoot() {
	}

	static synchronized void boot() {
		if (!booted) {
			SharedConstants.tryDetectVersion();
			Bootstrap.bootStrap();
			booted = true;
		}
	}
}
