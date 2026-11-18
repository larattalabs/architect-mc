package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.mojang.blaze3d.platform.InputConstants;
import dev.larattalabs.architect.client.hud.KeyDefaults;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (PR K1) No two global defaults of Architect and lab-ui share a key (K was both Build a link and the jobs panel), and no
 * default is one of Steward's Y, I or U (S-PR-2). The placing keys (PR A4) act only while placing, so they are checked per
 * context in {@code PlacingKeysTest}.
 */
class KeyDefaultsTest {
	@Test
	void globalsNeverCollide() {
		List<Integer> all = new ArrayList<>(KeyDefaults.globals());
		all.addAll(dev.larattalabs.labui.ui.KeyDefaults.globals());
		assertEquals(all.size(), new HashSet<>(all).size(), "a default key is bound twice: " + all);
	}

	@Test
	void buildLinkIsNAndJobsKeepsK() {
		assertEquals(InputConstants.KEY_N, KeyDefaults.BUILD_LINK);
		assertEquals(InputConstants.KEY_K, dev.larattalabs.labui.ui.KeyDefaults.JOBS);
	}

	/** 26.3 numbers keys by SDL scancode, not GLFW: the pure tables must equal InputConstants (GLFW 66 for B was F9). */
	@Test
	void theCodesAre26point3InputConstants() {
		assertEquals(List.of(InputConstants.KEY_B, InputConstants.KEY_J, InputConstants.KEY_Z, InputConstants.KEY_N), KeyDefaults.globals());
		assertEquals(List.of(InputConstants.KEY_Y, InputConstants.KEY_I, InputConstants.KEY_U), dev.larattalabs.labui.ui.KeyDefaults.STEWARD_RESERVED);
		assertEquals(InputConstants.KEY_F1, dev.larattalabs.labui.ui.HelpKeys.F1);
		assertEquals(InputConstants.KEY_SLASH, dev.larattalabs.labui.ui.HelpKeys.SLASH);
		assertEquals(InputConstants.KEY_ESCAPE, dev.larattalabs.labui.ui.HelpKeys.ESCAPE);
	}

	@Test
	void noDefaultTakesStewardsKeys() {
		for (int k : KeyDefaults.globals()) {
			assertFalse(dev.larattalabs.labui.ui.KeyDefaults.STEWARD_RESERVED.contains(k), (char) k + " is Steward's");
		}
	}
}
