package dev.larattalabs.architect.client.help;

import java.util.List;

/**
 * (PR F1) The guided first build's step machine (pure). Offered once, the first time the Architect screen opens in a world with none of
 * the player's sites, as a card with Start / Not now / Don't ask again; it never starts on its own. Each step advances on the real
 * action, never on a timer. Creative: (1) Library &gt; cabin, (2) Place, (3) move, then rotate, (4) read the outline, (5) Enter,
 * (6) "Press Z twice to undo, or keep it". Survival: step 5 makes a construction site, (6) open its crate, (7) undo or keep. Then a
 * closing card offers Design (it needs the design helper; the tour never does). Esc pauses it; Status restarts it.
 */
public final class GuideModel {
	public enum State {
		NEW, OFFERED, RUNNING, PAUSED, CLOSING, DONE, DECLINED
	}

	public enum Step {
		PICK_CABIN, PLACE, MOVE_ROTATE, READ_OUTLINE, ENTER, OPEN_CRATE, UNDO_OR_KEEP
	}

	public enum Event {
		SCREEN_OPENED_NO_SITES, START, NOT_NOW, DECLINE, PICKED, PLACING, ROTATED, VERDICT_OK, VERDICT_REFUSED, PLACED, CRATE_OPENED, UNDONE, KEEP,
		ESC, RESUME, RESTART, CLOSE
	}

	/** One card: its title, its body and its buttons (ids, labels). */
	public record Card(String title, String body, List<String[]> buttons) {
	}

	/** The bundled design the tour places. */
	public static final String CABIN = "cabin";
	private State state;
	private Step step;
	private boolean survival;
	private boolean sawRefused;

	public GuideModel(State state, Step step, boolean survival) {
		this.state = state;
		this.step = step == null ? Step.PICK_CABIN : step;
		this.survival = survival;
	}

	public State state() {
		return state;
	}

	public Step step() {
		return step;
	}

	public boolean survival() {
		return survival;
	}

	public void survival(boolean on) {
		survival = on;
	}

	/** The steps of this mode, in order (survival adds the crate). */
	public List<Step> steps() {
		return survival ? List.of(Step.values()) : List.of(Step.PICK_CABIN, Step.PLACE, Step.MOVE_ROTATE, Step.READ_OUTLINE, Step.ENTER, Step.UNDO_OR_KEEP);
	}

	public int number() {
		return steps().indexOf(step) + 1;
	}

	/** Feeds one event; true when the state or step changed. {@code arg} is the design id for PICKED and PLACING. */
	public boolean on(Event e, String arg) {
		State s0 = state;
		Step p0 = step;
		switch (e) {
			case SCREEN_OPENED_NO_SITES -> {
				if (state == State.NEW) {
					state = State.OFFERED;
				}
			}
			case START -> {
				if (state == State.OFFERED || state == State.NEW) {
					state = State.RUNNING;
					step = Step.PICK_CABIN;
				}
			}
			case NOT_NOW -> {
				if (state == State.OFFERED) {
					state = State.NEW; // asked again next time
				}
			}
			case DECLINE -> {
				if (state == State.OFFERED || state == State.NEW) {
					state = State.DECLINED;
				}
			}
			case RESTART -> {
				state = State.RUNNING;
				step = Step.PICK_CABIN;
				sawRefused = false;
			}
			case ESC -> {
				if (state == State.RUNNING) {
					state = State.PAUSED;
				}
			}
			case RESUME -> {
				if (state == State.PAUSED) {
					state = State.RUNNING;
				}
			}
			case CLOSE -> {
				if (state == State.CLOSING) {
					state = State.DONE;
				}
			}
			default -> {
				if (state == State.RUNNING) {
					advance(e, arg);
				}
			}
		}
		return s0 != state || p0 != step;
	}

	private void advance(Event e, String arg) {
		switch (step) {
			case PICK_CABIN -> {
				if (e == Event.PICKED && CABIN.equals(arg)) {
					step = Step.PLACE;
				} else if (e == Event.PLACING && CABIN.equals(arg)) {
					step = Step.MOVE_ROTATE; // placed straight from the detail: the pick is done too
				}
			}
			case PLACE -> {
				if (e == Event.PLACING && CABIN.equals(arg)) {
					step = Step.MOVE_ROTATE;
				}
			}
			case MOVE_ROTATE -> {
				if (e == Event.ROTATED) {
					step = Step.READ_OUTLINE;
				}
			}
			case READ_OUTLINE -> {
				if (e == Event.VERDICT_REFUSED) {
					sawRefused = true;
				} else if (e == Event.VERDICT_OK) {
					step = Step.ENTER;
				}
			}
			case ENTER -> {
				if (e == Event.PLACED) {
					step = survival ? Step.OPEN_CRATE : Step.UNDO_OR_KEEP;
				}
			}
			case OPEN_CRATE -> {
				if (e == Event.CRATE_OPENED) {
					step = Step.UNDO_OR_KEEP;
				}
			}
			case UNDO_OR_KEEP -> {
				if (e == Event.UNDONE || e == Event.KEEP) {
					state = State.CLOSING;
				}
			}
		}
		if (e == Event.PLACED && step != Step.OPEN_CRATE && step != Step.UNDO_OR_KEEP) {
			// placed before the tour asked for it (Enter early): skip ahead
			step = survival ? Step.OPEN_CRATE : Step.UNDO_OR_KEEP;
		}
	}

	/**
	 * The card shown now, or null. Key labels come in live ({@code rotate}, {@code enter}, {@code undo}), and the outline words follow
	 * the palette ({@code okWords}: "sage green", "blue").
	 */
	public Card card(String rotate, String enter, String undo, String okWords) {
		return switch (state) {
			case OFFERED -> new Card("Place your first building: a free cabin", "A short tour: pick a design, place it, and undo it if you like. "
				+ "No design helper needed.", List.of(new String[] {"guide:start", "Start"}, new String[] {"guide:not_now", "Not now"},
					new String[] {"guide:decline", "Don't ask again"}));
			case PAUSED -> new Card("Tour paused", "Pick it up where you left it.", List.of(new String[] {"guide:resume", "Resume"},
				new String[] {"guide:decline", "End the tour"}));
			case CLOSING -> new Card("That's the tour", "Next: design your own building on the Design tab (it needs the design helper).",
				List.of(new String[] {"guide:design", "Design"}, new String[] {"guide:close", "Done"}));
			case RUNNING -> new Card("Step " + number() + " of " + steps().size(), switch (step) {
				case PICK_CABIN -> "Open the Library tab and pick the cabin.";
				case PLACE -> "Press Place: the cabin follows your view as a ghost.";
				case MOVE_ROTATE -> "Walk to where it should stand, then press " + rotate + " to turn it.";
				case READ_OUTLINE -> sawRefused ? "The outline is dashed: it can't go here. Move until it is solid " + okWords + "."
					: "A solid " + okWords + " outline means it fits; a dashed one means it can't go there.";
				case ENTER -> survival ? "Press " + enter + ": it becomes a construction site that builds from its crate."
					: "Press " + enter + " to place it.";
				case OPEN_CRATE -> "Open the site's crate and put materials in it.";
				case UNDO_OR_KEEP -> "Press " + undo + " twice to undo it, or keep it.";
			}, step == Step.UNDO_OR_KEEP ? List.<String[]>of(new String[] {"guide:keep", "Keep it"}) : List.of());
			default -> null;
		};
	}
}
