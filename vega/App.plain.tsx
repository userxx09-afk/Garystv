// Fallback Vega app with no extra packages (CI uses it only if App.tsx's packages won't build).
// The server address is kept in the page's own storage (domStorageEnabled).
import React from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { WebView } from '@amazon-devices/webview';

export const App = () => (
  <View style={styles.root}>
    <WebView
      hasTVPreferredFocus={true}
      source={{ uri: 'file:///pkg/assets/www/index.html' }}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      allowFileAccess={true}
      allowSystemKeyEvents={true}
      onMessage={(event: { nativeEvent: { data: string } }) => {
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
