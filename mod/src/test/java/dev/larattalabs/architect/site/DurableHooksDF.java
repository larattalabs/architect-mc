package dev.larattalabs.architect.site;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Path;

/** (slice DF, TEST) DurableFile's force seam for tests outside the site package: folder forces that fail (IN_DOUBT after a rename). */
public final class DurableHooksDF {
	private DurableHooksDF() {
	}

	public static void failFolderForces() {
		DurableFile.FORCER = new DurableFile.Forcer() {
			@Override
			public void file(FileChannel ch) throws IOException {
				ch.force(true);
			}

			@Override
			public void dir(Path dir) throws IOException {
				throw new IOException("injected folder force failure (TEST)");
			}
		};
	}

	/** Only the force of the folder {@code only} itself fails: a write's post-rename force (IN_DOUBT), not its folder chain's (REFUSED). */
	public static void failFolderForcesOf(Path only) {
		Path o = only.toAbsolutePath().normalize();
		DurableFile.FORCER = new DurableFile.Forcer() {
			@Override
			public void file(FileChannel ch) throws IOException {
				ch.force(true);
			}

			@Override
			public void dir(Path dir) throws IOException {
				if (dir.toAbsolutePath().normalize().equals(o)) {
					throw new IOException("injected folder force failure of " + o + " (TEST)");
				}
				DurableFile.forceDir(dir);
			}
		};
	}

	public static void reset() {
		DurableFile.FORCER = DurableFile.REAL;
		DurableFile.worldChanged(null);
	}
}
