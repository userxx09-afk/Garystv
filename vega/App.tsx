// GarysTV on Vega Fire TV: one full-screen WebView showing the same screens as the other TV apps
// (assets/www, copied in by vega/build.js). The page finds the GarysTV server itself (tizen/tv.js).
// This side gives the page two things a plain web page can't get on Vega:
//  - the last GarysTV server it connected to, kept in the app's own storage (AsyncStorage), so it
//    survives the app closing even if the page's storage doesn't;
//  - the stick's own IP address, so the page knows which network to search.
// Both reach the page as window.GTV_VEGA before tv.js runs.
import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { WebView } from '@amazon-devices/webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Network from '@amazon-devices/expo-network';

const SAVED = 'gtv.server';

// Never let a slow or missing service hold up the app.
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

export const App = () => {
  const [boot, setBoot] = useState<string | null>(null);
  const ipRef = useRef('');
  const nameRef = useRef(''); // the server's computer name, to find it again if its address changes
  // What the page gets on every load (a reload too, e.g. after "switch server").
  const bootFor = (server: string) => `window.GTV_VEGA = ${JSON.stringify({ server, ip: ipRef.current, name: nameRef.current })}; true;`;

  useEffect(() => {
    (async () => {
      const [server, ip, name] = await Promise.all([
        within(AsyncStorage.getItem(SAVED), 1500, null),
        within(Network.getIpAddressAsync(), 1500, ''),
        within(AsyncStorage.getItem(`${SAVED}.name`), 1500, null),
      ]);
      nameRef.current = name || '';
      ipRef.current = ip && ip !== '0.0.0.0' ? ip : '';
      setBoot(bootFor(server || ''));
    })();
  }, []);

  if (boot === null) return <View style={styles.root} />;
  return (
    <View style={styles.root}>
      <WebView
        hasTVPreferredFocus={true}
        source={{ uri: 'file:///pkg/assets/www/index.html' }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        allowSystemKeyEvents={true}
        injectedJavaScriptBeforeContentLoaded={boot}
        onMessage={(event: { nativeEvent: { data: string } }) => {
          const data = event.nativeEvent.data;
          // tv.js asks to close the app (Back on the Home screen, or on the connect screen).
          if (data === 'exit') BackHandler.exitApp();
          // tv.js connected to a server (or forgot it: "save:").
          else if (data.startsWith('save:')) {
            AsyncStorage.setItem(SAVED, data.slice(5)).catch(() => {});
            setBoot(bootFor(data.slice(5)));
          }
          // ...and the server's computer name, to find it again if its address changes.
          else if (data.startsWith('savename:')) {
            nameRef.current = data.slice(9);
            AsyncStorage.setItem(`${SAVED}.name`, nameRef.current).catch(() => {});
          }
        }}
        style={styles.web}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
});

export default App;
