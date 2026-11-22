// SPDX-License-Identifier: Apache-2.0
#include "../src/drivers/yahboom.h"
#include <cassert>
#include <iostream>

int main() {
    Yahboom board;
    board.begin();
    board.requestFeedback();
    assert(Serial1.output == "$upload:1,0,0#");
    Serial1.output.clear();
    assert(board.output(300, -120, 10));
    assert(Serial1.output == "$pwm:0,0,300,-120#");
    assert(board.output(0, 0, 11, true));
    assert(Serial1.output == "$pwm:0,0,300,-120#$pwm:0,0,0,0#");
    Serial1.input = "read_flash:OK!\r\n$MAll:104,-2,";
    assert(board.read(100) && board.feedback.sequence == 0);
    Serial1.input += "134,1#\r\n$MALL:104,-2,137,-3#";
    assert(board.read(110) && board.feedback.sequence == 2);
    assert(board.feedback.ticks[0] == 3 && board.feedback.ticks[1] == -4);
    Serial1.input += "$MAll:4,0,2,0junk#";
    assert(board.read(120) && board.feedback.sequence == 2);
    board.requestBattery();
    assert(Serial1.output.find("$read_vol#") != std::string::npos);
    Serial1.input += "$Battery:10.";
    assert(board.read(200) && !board.battery.fresh(200));
    Serial1.input += "50V#";
    assert(board.read(210) && board.battery.percent() == 5 && !board.battery.low);
    Serial1.input += "$Battery:10.4junk#";
    assert(board.read(220) && board.battery.last == 210);
    for (int i = 1; i <= 6; ++i) {
        Serial1.input += "$Battery:10.20V#";
        assert(board.read(210 + 1000*i));
        assert(board.battery.low == (i == 6));
    }
    assert(!board.battery.fresh(10000));
    Serial1.input += "$Battery:12.60V#";
    assert(board.read(11000) && !board.battery.low && board.battery.percent() == 100);
    Serial1.freeBytes = 0;
    assert(!board.output(0, 0, 130, true));
    std::cout << "Verified Yahboom UART frames, fragmented feedback and stop output.\n";
}
