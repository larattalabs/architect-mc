package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.region.RegionStore;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice DF, rule 3) The region store's writes on T0's durable path: the file forced, renamed, then its folder forced and every new folder's
 * entry forced in its parent (a file's fsync does not persist its directory entry). A failure before the rename keeps the old file and
 * throws; a failed folder force after the rename throws too (IN_DOUBT is never read as saved). Fails on main by assertion: RegionStore.write
 * forced the file only.
 */
class RegionStoreDurableDFTest {
	@TempDir
	Path tmp;
	final List<Path> dirs = new ArrayList<>();
	int files;

	@BeforeEach
	void recorder() {
		DurableFile.worldChanged(null); // no folder confirmation left over from another test
		DurableFile.FORCER = new DurableFile.Forcer() {
			@Override
			public void file(FileChannel ch) throws IOException {
				files++;
				ch.force(true);
			}

			@Override
			public void dir(Path dir) throws IOException {
				dirs.add(dir.toAbsolutePath().normalize());
				DurableFile.forceDir(dir);
			}
		};
	}

	@AfterEach
	void reset() {
		DurableFile.FORCER = DurableFile.REAL;
		DurableFile.worldChanged(null);
		RegionStore.failNext = null;
		RegionStore.failSticky = false;
	}

	@Test
	void aWriteForcesItsFolderAndEveryNewFoldersEntry() throws IOException {
		Path f = tmp.resolve("architect-regions/r1/fluids.json");
		RegionStore.write(f, "{\"a\":1}".getBytes(StandardCharsets.UTF_8));
		assertArrayEquals("{\"a\":1}".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(f), "the bytes as given (no member added)");
		Path r1 = f.getParent().toAbsolutePath().normalize(), regions = r1.getParent(), root = regions.getParent();
		assertTrue(files >= 1, "the temp file forced");
		assertTrue(dirs.contains(r1), "the file's own folder forced after the rename: " + dirs);
		assertTrue(dirs.contains(regions), "the new folder r1's entry forced in architect-regions: " + dirs);
		assertTrue(dirs.contains(root), "the new folder architect-regions' entry forced in its parent: " + dirs);
		assertFalse(Files.exists(f.resolveSibling("fluids.json.tmp")), "no temp file left");
		// a rewrite into the existing folder still forces that folder (the rename is a new entry)
		dirs.clear();
		RegionStore.write(f, "{\"a\":2}".getBytes(StandardCharsets.UTF_8));
		assertTrue(dirs.contains(r1), "the rewrite's folder forced: " + dirs);
	}

	@Test
	void aFailedFolderForceAfterTheRenameIsNotASave() throws IOException {
		Path f = tmp.resolve("r2/region.json");
		RegionStore.write(f, "{\"v\":1}".getBytes(StandardCharsets.UTF_8));
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
		assertThrows(IOException.class, () -> RegionStore.write(f, "{\"v\":2}".getBytes(StandardCharsets.UTF_8)), "IN_DOUBT throws: the caller never reads it as saved");
	}

	@Test
	void aStickyInjectedFailureHoldsUntilOff() throws IOException {
		Path f = tmp.resolve("r3/fluids.json");
		RegionStore.failNext = "fluids.json";
		RegionStore.failSticky = true;
		assertThrows(IOException.class, () -> RegionStore.write(f, new byte[] {1}));
		assertThrows(IOException.class, () -> RegionStore.write(f, new byte[] {1}), "still armed");
		assertFalse(Files.exists(f), "nothing written");
		RegionStore.failNext = null;
		RegionStore.write(f, new byte[] {1});
		assertTrue(Files.exists(f));
	}
}
