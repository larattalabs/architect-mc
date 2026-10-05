package dev.larattalabs.architect.client.screen;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/** Library file operations of the Library tab. Deleting moves a design's folder to {@code <gameDir>/architect/library-trash/}. */
final class LibraryFiles {
	private LibraryFiles() {
	}

	/** Moves a user design's folder to the trash ({@code <id>-<ms>}); bundled designs cannot be deleted. */
	static Path trash(Blueprints.Entry e) throws IOException {
		Path dir = e.dir();
		if (dir == null) {
			throw new IOException("a bundled design cannot be deleted");
		}
		Path trash = Blueprints.gameDataDir().resolve("library-trash");
		Files.createDirectories(trash);
		Path to = trash.resolve(e.blueprint().id() + "-" + System.currentTimeMillis());
		Files.move(dir, to, StandardCopyOption.ATOMIC_MOVE);
		Architect.LOGGER.info("Library: moved {} to {}", dir, to);
		return to;
	}
}
