// SPDX-License-Identifier: Apache-2.0
package io.whistlebot.console;

import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.Inet4Address;
import java.util.HashMap;
import java.util.Map;

@CapacitorPlugin(name = "RoverDiscovery")
public class RoverDiscovery extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private Search active;

    @PluginMethod
    public void find(PluginCall call) {
        main.post(() -> {
            if (active != null) active.finish(null);
            active = new Search(call);
            active.start();
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> { if (active != null) active.finish(null); });
    }

    private class Search implements NsdManager.DiscoveryListener {
        final NsdManager nsd = getContext().getSystemService(NsdManager.class);
        final PluginCall call;
        final String wanted;
        final Map<String, NsdServiceInfo> matches = new HashMap<>();
        final Runnable timeout = () -> finish(null);
        final Runnable listResults = () -> {
            JSObject result = new JSObject();
            result.put("devices", new JSArray(new java.util.TreeSet<>(matches.keySet())));
            finish(result);
        };
        boolean browsing, resolving;

        Search(PluginCall call) {
            this.call = call;
            wanted = call.getString("deviceId", "");
        }

        void start() {
            try {
                nsd.discoverServices("_whistlebot._tcp", NsdManager.PROTOCOL_DNS_SD, this);
                browsing = true;
                main.postDelayed(timeout, 4500);
            } catch (RuntimeException e) {
                finish(null);
            }
        }

        void select() {
            if (active != this || resolving || matches.size() != 1) return;
            resolving = true;
            try {
                nsd.resolveService(matches.values().iterator().next(), resolver);
            } catch (RuntimeException e) {
                finish(null);
            }
        }

        void finish(JSObject result) {
            if (active != this) return;
            active = null;
            main.removeCallbacks(timeout);
            main.removeCallbacks(listResults);
            if (browsing) {
                try { nsd.stopServiceDiscovery(this); } catch (IllegalArgumentException ignored) {}
            }
            call.resolve(result == null ? new JSObject() : result);
        }

        public void onServiceFound(NsdServiceInfo service) {
            main.post(() -> {
                String id = service.getServiceName();
                if (active != this || !id.matches("Whistle-[0-9A-F]{6}") ||
                    (!wanted.isEmpty() && !wanted.equals(id))) return;
                matches.put(id, service);
                if (!wanted.isEmpty()) select();
            });
        }
        public void onDiscoveryStarted(String type) {
            main.post(() -> { if (active == this && wanted.isEmpty()) main.postDelayed(listResults, 3000); });
        }
        public void onServiceLost(NsdServiceInfo service) {
            main.post(() -> matches.remove(service.getServiceName()));
        }
        private final NsdManager.ResolveListener resolver = new NsdManager.ResolveListener() {
            public void onServiceResolved(NsdServiceInfo service) {
                main.post(() -> {
                    JSObject result = new JSObject();
                    if (matches.size() == 1 && matches.containsKey(service.getServiceName()) && service.getPort() == 80) {
                        for (java.net.InetAddress addr : android.os.Build.VERSION.SDK_INT >= 34
                                ? service.getHostAddresses() : java.util.Collections.singletonList(service.getHost())) {
                            if (addr instanceof Inet4Address) {
                                result.put("host", addr.getHostAddress());
                                result.put("deviceId", service.getServiceName());
                                break;
                            }
                        }
                    }
                    finish(result);
                });
            }
            public void onResolveFailed(NsdServiceInfo service, int error) { main.post(timeout); }
        };
        public void onStartDiscoveryFailed(String type, int error) { main.post(timeout); }
        public void onStopDiscoveryFailed(String type, int error) { main.post(timeout); }
        public void onDiscoveryStopped(String type) {}
    }
}
