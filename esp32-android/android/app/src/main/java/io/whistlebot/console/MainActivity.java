package io.whistlebot.console;

import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private WifiManager.WifiLock controlWifiLock;

    @Override
    protected void onCreate(Bundle state) {
        registerPlugin(RoverDiscovery.class);
        super.onCreate(state);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        if (controlWifiLock == null) {
            WifiManager wifi = getApplicationContext().getSystemService(WifiManager.class);
            if (wifi == null) return;
            controlWifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "WhistleBot:Control");
        }
        if (!controlWifiLock.isHeld()) controlWifiLock.acquire();
    }

    @Override
    public void onPause() {
        if (controlWifiLock != null && controlWifiLock.isHeld()) controlWifiLock.release();
        super.onPause();
    }
}
