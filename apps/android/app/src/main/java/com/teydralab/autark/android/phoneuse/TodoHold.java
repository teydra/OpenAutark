// Owns the lifecycle of the physical hold; the recorder and screenshot live in TodoButton.
package com.teydralab.autark.android.phoneuse;

final class TodoHold {
    private enum State { IDLE, HELD, RELEASED }
    private State state = State.IDLE;

    boolean active() { return state != State.IDLE; }
    boolean released() { return state == State.RELEASED; }

    boolean begin(Runnable record) {
        if (active()) return false;
        state = State.HELD;
        record.run();
        return true;
    }

    void release(Runnable send) {
        if (state != State.HELD) return;
        state = State.RELEASED;
        send.run();
    }

    void reset() { state = State.IDLE; }
}
