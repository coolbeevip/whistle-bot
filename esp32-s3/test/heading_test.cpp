// SPDX-License-Identifier: Apache-2.0
#include "../src/control/heading.h"
#include <cassert>

int main() {
    HeadingEstimator estimator;
    const float downMount[]{0, 0, -1}, idleGyro[]{0, 0, -0.75f};
    uint32_t time = UINT32_MAX - 1000;
    for (int i = 0; i < 104; ++i)
        estimator.update(time += 20, downMount, idleGyro, false);
    assert(!estimator.heading.ready);
    for (int i = 0; i < 104; ++i)
        estimator.update(time += 20, downMount, idleGyro, true);
    assert(estimator.heading.fresh(time));
    float leftTurn[]{0, 0, -90.75f};
    for (int i = 0; i < 201; ++i)
        estimator.update(time += 20, downMount, leftTurn, false);
    assert(std::abs(estimator.heading.degrees - 360.9) < 0.02);
    assert(!estimator.heading.fresh(time + 100));
    estimator.update(time += 150, downMount, idleGyro, true);
    assert(!estimator.heading.ready);

    // A simple differential chassis with wheel slip. End-to-end goal feedback
    // must converge from measured body rotation, even when wheel travel lies.
    for (float target : {-360.f, -90.f, 90.f, 360.f}) {
        PrecisionGoal turn;
        Heading body;
        int wheels[2]{};
        turn.begin(target, true, body, 0);
        for (unsigned ms = 0; ms < 30000; ms += 10) {
            turn.update(body, 0, wheels, ms);
            if (turn.close()) break;
            body.degrees += (wheels[1] - wheels[0]) * 0.003;
        }
        assert(std::abs(target - body.degrees) <= turn.tolerance);
    }

    PrecisionGoal goal;
    Heading h;
    int speed[2];
    for (int sign : {-1, 1}) {
        h.degrees = 37;
        goal.begin(sign * 90, true, h, 0);
        goal.update(h, 500, speed, 100); // wheel slip cannot complete a turn
        assert(!goal.close() && speed[0] * sign < 0 && speed[1] * sign > 0);
        h.degrees += sign * 90;
        goal.update(h, 0, speed, 200);
        assert(goal.close());
        h.degrees -= sign * 4;
        h.rate = 0;
        goal.update(h, 0, speed, 220);
        assert(!goal.approachingStop && speed[1] * sign > 0);
        h.rate = sign * 30;
        goal.update(h, 0, speed, 240);
        assert(!goal.close() && goal.approachingStop && speed[1] == 0);
        h.degrees += sign * 7; // crosses the full tolerance band between samples
        goal.update(h, 0, speed, 260);
        assert(goal.approachingStop && speed[0] == 0);
        h.rate = 0;
        h.at = 280;
        assert(!goal.rested(h, true));
        assert(!goal.rested(h, true)); // same IMU sample
        h.at += 100;
        h.rate = sign * 4;
        assert(!goal.rested(h, true));
        h.rate = 0;
        h.at += 20;
        assert(!goal.rested(h, true));
        h.at += 149;
        assert(!goal.rested(h, true));
        h.at++;
        assert(goal.rested(h, true) && !goal.close()); // settled outside: correction required
        h.degrees -= sign * 3;
        goal.update(h, 0, speed, h.at);
        assert(!goal.rested(h, true));
        h.at += 150;
        assert(goal.rested(h, true) && goal.close());
        goal.begin(sign * 500, false, h, 200);
        h.degrees += 4;
        goal.update(h, 0, speed, 300);
        assert(speed[0] > speed[1] && speed[0]*sign > 0 && speed[1]*sign > 0);
        goal.update(h, sign * 500, speed, 500);
        assert(goal.close());

        goal.begin(sign * 1000, false, h, 0, 400);
        goal.update(h, 0, speed, 0);
        assert(speed[0] == sign * 400 && speed[1] == sign * 400);
        goal.update(h, sign * 900, speed, 1000);
        assert(speed[0] * sign > 0 && speed[0] * sign < 250);
        goal.update(h, sign * 990, speed, 1500);
        assert(speed[0] == sign * 18 && speed[1] == sign * 18);
        goal.begin(sign * 50, false, h, 0, 800);
        goal.update(h, 0, speed, 0);
        assert(speed[0] == sign * 90);
    }
}
