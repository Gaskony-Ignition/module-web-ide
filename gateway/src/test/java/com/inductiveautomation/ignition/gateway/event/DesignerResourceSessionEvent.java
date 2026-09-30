package com.inductiveautomation.ignition.gateway.event;

import com.inductiveautomation.ignition.designer.concurrency.ResourceSession;

/**
 * A stand-in for the platform's own event type — TEST SOURCE ONLY.
 *
 * <h2>Why this exists in this package, which is not ours</h2>
 *
 * <p>{@code DesignerPresenceListener} reaches the real event by CLASS NAME,
 * because the real one ships in {@code gateway.jar} and never in the SDK, so
 * there is nothing to compile against. That leaves the names — the class, the
 * nested types, and the two accessors — as an unwritten contract that a rename
 * would break silently: the listener would simply stop matching, and Designer
 * presence would quietly become session-level with nothing failing anywhere.</p>
 *
 * <p>So the contract is written down here, as a class with exactly the names the
 * real one has, in exactly its package. A test against this proves the listener
 * reads the shape it claims to read. It cannot prove the PLATFORM still has that
 * shape — only the gateway can answer that, which is what
 * {@code validate_v30_presence.py} is for — but it does mean a change to the
 * listener's expectations has to be made deliberately, in two places.</p>
 *
 * <p>Verified against 8.3.8's {@code gateway-8.3.8.jar} on 07/09/2026 with
 * {@code javap}: {@code UpdateEvent} is a record of {@code (String projectName,
 * ResourceSession update)} and {@code DestroyEvent} of {@code (String
 * projectName, String publicId)}.</p>
 */
public interface DesignerResourceSessionEvent {

    String projectName();

    /** The platform's record, reduced to what this module reads off it. */
    record UpdateEvent(String projectName, ResourceSession update)
        implements DesignerResourceSessionEvent {
    }

    record DestroyEvent(String projectName, String publicId)
        implements DesignerResourceSessionEvent {
    }
}
