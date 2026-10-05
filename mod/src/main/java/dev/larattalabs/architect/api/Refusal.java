package dev.larattalabs.architect.api;

/** Why a placement is refused: a typed reason and the message the player would see. */
public record Refusal(Reason reason, String message) {
}
