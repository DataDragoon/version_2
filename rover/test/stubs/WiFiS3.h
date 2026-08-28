#pragma once
#include "Arduino.h"
#define WL_CONNECTED 3
#define WL_IDLE_STATUS 0
struct WiFiStub {
    void disconnect() {}
    void begin(const char*, const char*) {}
    int status() { return WL_CONNECTED; }
    IPAddress localIP() { return IPAddress(1,2,3,4); }
    long RSSI() { return -50; }
};
extern WiFiStub WiFi;
inline void _serial_print_ip(SerialStub& s, const IPAddress&) { (void)s; }
