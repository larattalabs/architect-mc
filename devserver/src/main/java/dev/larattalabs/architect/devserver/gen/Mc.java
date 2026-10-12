package dev.larattalabs.architect.devserver.gen;

/**
 * The headless host's stand-in for the client's {@code Minecraft} in a DevBridge handler's signature. The hooks derived from
 * the client's sources (devserver/build.gradle {@code genHooks}) only pass it along to {@link DevBridge#onClient}.
 */
public final class Mc {
	public static final Mc INSTANCE = new Mc();

	private Mc() {
	}

	/** Runs {@code r} on the host thread (the client thread's stand-in). */
	public void execute(Runnable r) {
		DevBridge.HOST.execute(r);
	}
}
