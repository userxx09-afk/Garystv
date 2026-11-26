// GarysTV on Vega Fire TV: one full-screen WebView showing the same screens as the other TV apps
// (assets/www, copied in by vega/build.js). The page finds the GarysTV server itself (tizen/tv.js).
import React from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { WebView } from '@amazon-devices/webview';

export const App = () => (
  <View style={styles.root}>
    <WebView
      hasTVPreferredFocus={true}
      source={{ uri: 'file:///pkg/assets/www/index.html' }}
      javaScriptEnabled={true}
      allowSystemKeyEvents={true}
      onMessage={(event: { nativeEvent: { data: string } }) => {
        // tv.js asks to close the app (Back on the Home screen, or on the connect screen).
        if (event.nativeEvent.data === 'exit') BackHandler.exitApp();
      }}
      style={styles.web}
    />
  </View>
);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
});

export default App;
