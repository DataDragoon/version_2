#pragma once
#include "Arduino.h"
#define WL_CONNECTED 3
#define WL_IDLE_STATUS 0
struct WiFiStub {
    void disconnect() {}
    void begin(const char*, const char*) {}
    void config(IPAddress) {}
    void config(IPAddress, IPAddress, IPAddress, IPAddress) {}
    void end() {}
    uint8_t* macAddress(uint8_t* mac) { for (int i = 0; i < 6; ++i) mac[i] = 0; return mac; }
    int status() { return WL_CONNECTED; }
    IPAddress localIP() { return IPAddress(1,2,3,4); }
    long RSSI() { return -50; }
};
extern WiFiStub WiFi;
inline void _serial_print_ip(SerialStub& s, const IPAddress&) { (void)s; }
