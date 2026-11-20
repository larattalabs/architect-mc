package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** (slice T4R, row T4R-no-resume; N7) {@code /architect removal resume} is gone: {@code /architect txn resolve} is the only ops path. */
class T4RNoResumeTest {
	@Test
	void removalResumeIsNotRegistered() throws Exception {
		System.out.println("ROW T4R-no-resume");
		for (Method m : RepairCommands.class.getDeclaredMethods()) {
			assertNotEquals("resumeRemoval", m.getName(), "T4R-no-resume: RepairCommands still has resumeRemoval");
		}
		for (Method m : Groups.class.getDeclaredMethods()) {
			assertNotEquals("resumeStalled", m.getName(), "T4R-no-resume: Groups still has resumeStalled (the ops resume)");
		}
		String src = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/RepairCommands.java"));
		assertFalse(src.contains("Commands.literal(\"resume\")"), "T4R-no-resume: RepairCommands registers a resume literal");
	}
}
