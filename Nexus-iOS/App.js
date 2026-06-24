import 'react-native-url-polyfill/auto';
import React, { useState, useEffect } from 'react';
import { 
  StyleSheet, Text, View, TextInput, TouchableOpacity, FlatList, Image, 
  ActivityIndicator, Alert, Dimensions, StatusBar, Animated, Easing, KeyboardAvoidingView, Platform
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import JSZip from 'jszip';
import EventSource from 'react-native-sse';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';

const BACKEND_URL = "https://mahirun.hicanh69.workers.dev";
const { width, height } = Dimensions.get('window');

export default function App() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  
  const [savedChapters, setSavedChapters] = useState([]);
  const [currentChapter, setCurrentChapter] = useState(null); 
  const [isReaderUIHiden, setIsReaderUIHiden] = useState(false);

  // Animations
  const glowAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    loadSavedChapters();
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(glowAnim, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: false })
      ])
    ).start();
  }, []);

  const getChapDir = () => FileSystem.documentDirectory + 'manga_chapters/';

  const loadSavedChapters = async () => {
    try {
      const dir = getChapDir();
      const dirInfo = await FileSystem.getInfoAsync(dir);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      }
      const files = await FileSystem.readDirectoryAsync(dir);
      // Sắp xếp chapter mới nhất lên đầu
      files.sort((a,b) => b.localeCompare(a));
      setSavedChapters(files);
    } catch(e) {
      console.log("Error loading chapters", e);
    }
  };

  const extractChapInfo = (url) => {
    try {
      const parts = url.split('/');
      const chapIdx = parts.indexOf('chapter');
      if (chapIdx !== -1 && parts.length > chapIdx + 1) {
        return parts[chapIdx + 1].substring(0, 8); // Lấy 1 đoạn ID
      }
    } catch(e) {}
    return Date.now().toString().substring(6);
  };

  const handleDownload = async () => {
    if (!url.includes('mangadex.org')) {
      Alert.alert('NEXUS', 'Chỉ hỗ trợ link MangaDex. Vui lòng kiểm tra lại.');
      return;
    }
    setLoading(true);
    setStatus('Đang khởi tạo Batch Engine...');
    setProgress(0);

    try {
      const formData = new FormData();
      formData.append("url", url);
      formData.append("prompt_mode", "none");
      
      await fetch(`${BACKEND_URL}/manga-auto-exec`, {
        method: 'POST',
        body: formData,
      });

      setStatus('Đang chờ Server bắt đầu dịch...');

      const source = new EventSource(`${BACKEND_URL}/manga-progress`);
      
      // Auto timeout after 3 mins
      const timeoutTimer = setTimeout(() => {
        source.close();
        setStatus('Lỗi: Timeout từ Server');
        setLoading(false);
      }, 180000);

      source.addEventListener('message', async (event) => {
        if (!event.data) return;
        try {
          const data = JSON.parse(event.data);
          setStatus(data.current || 'Đang xử lý...');
          if (data.total > 0) setProgress(data.done / data.total);

          if (data.status === 'complete' || data.status === 'error') {
            clearTimeout(timeoutTimer);
            source.close();
            if (data.status === 'complete' && data.download_link) {
              await downloadAndExtractZip(data.download_link, extractChapInfo(url));
            } else {
              setStatus('Lỗi: Server dịch thất bại!');
              setLoading(false);
            }
          }
        } catch(e) {}
      });

      source.addEventListener('error', (err) => {
        clearTimeout(timeoutTimer);
        source.close();
        setStatus('Mất kết nối SSE Stream');
        setLoading(false);
      });

    } catch (error) {
      setStatus('Lỗi kết nối đến Nexus Server');
      setLoading(false);
    }
  };

  const downloadAndExtractZip = async (filename, chapSubId) => {
    try {
      setStatus('Đang kéo ZIP (cbz) về máy...');
      const zipUri = FileSystem.cacheDirectory + filename;
      const downloadRes = await FileSystem.downloadAsync(`${BACKEND_URL}/download/${filename}`, zipUri);
      
      setStatus('Đang bung nén in-memory...');
      const zipB64 = await FileSystem.readAsStringAsync(zipUri, { encoding: FileSystem.EncodingType.Base64 });
      const zip = await JSZip.loadAsync(zipB64, { base64: true });
      
      // Format tên thư mục
      const now = new Date();
      const timeStr = `${now.getHours()}h${now.getMinutes()}`;
      const chapId = `Chap_${chapSubId}_${timeStr}`;
      
      const extractDir = getChapDir() + chapId + '/';
      await FileSystem.makeDirectoryAsync(extractDir, { intermediates: true });

      const files = Object.values(zip.files).filter(f => !f.dir);
      files.sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric: true}));

      let count = 0;
      for (const file of files) {
        const base64Data = await file.async("base64");
        await FileSystem.writeAsStringAsync(extractDir + file.name, base64Data, { encoding: FileSystem.EncodingType.Base64 });
        count++;
        setStatus(`Đang ghi vào Storage: ${count}/${files.length}`);
        setProgress(count / files.length);
      }

      await FileSystem.deleteAsync(zipUri, { idempotent: true });
      
      setStatus('HOÀN TẤT!');
      setTimeout(() => {
        setLoading(false);
        setUrl('');
        loadSavedChapters();
        openChapter(chapId);
      }, 1000);
      
    } catch(e) {
      setStatus('Lỗi giải nén: Dữ liệu hỏng hoặc rỗng');
      setLoading(false);
    }
  };

  const openChapter = async (chapId) => {
    const dir = getChapDir() + chapId + '/';
    const files = await FileSystem.readDirectoryAsync(dir);
    files.sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
    const uris = files.map(f => dir + f);
    setCurrentChapter(uris);
  };

  const deleteChapter = async (chapId) => {
    Alert.alert(
      "Xác nhận xóa",
      "Bạn có chắc muốn xóa vĩnh viễn Chapter này khỏi máy?",
      [
        { text: "Hủy", style: "cancel" },
        { text: "Xóa", onPress: async () => {
            const dir = getChapDir() + chapId;
            await FileSystem.deleteAsync(dir, { idempotent: true });
            loadSavedChapters();
        }, style: 'destructive' }
      ]
    );
  };

  if (currentChapter) {
    return (
      <View style={styles.readerContainer}>
        <StatusBar hidden={isReaderUIHiden} />
        
        {!isReaderUIHiden && (
          <LinearGradient
            colors={['rgba(0,0,0,0.9)', 'transparent']}
            style={styles.readerTopBar}
          >
            <TouchableOpacity style={styles.backBtnReader} onPress={() => setCurrentChapter(null)}>
              <Feather name="chevron-left" size={28} color="#00e5ff" />
              <Text style={styles.backBtnText}>Quay Lại</Text>
            </TouchableOpacity>
          </LinearGradient>
        )}

        <FlatList
          data={currentChapter}
          keyExtractor={(item, idx) => idx.toString()}
          showsVerticalScrollIndicator={false}
          bounces={false}
          renderItem={({item}) => (
            <TouchableOpacity activeOpacity={1} onPress={() => setIsReaderUIHiden(!isReaderUIHiden)}>
              <Image source={{uri: item}} style={{width: width, height: width * 1.5}} resizeMode="contain" />
            </TouchableOpacity>
          )}
        />
      </View>
    );
  }

  const glowBorderColor = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(0, 229, 255, 0.2)', 'rgba(0, 229, 255, 0.8)']
  });

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#050505" />
      
      {/* Background glow effect */}
      <View style={styles.bgGlow} />

      <View style={styles.header}>
        <Feather name="hexagon" size={32} color="#00e5ff" style={{marginRight: 10}} />
        <Text style={styles.title}>NEXUS<Text style={{color: '#fff'}}>_iOS</Text></Text>
      </View>
      
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{width: '100%'}}>
        <View style={styles.glassPanel}>
          <Text style={styles.panelTitle}>BATCH TRANSLATOR</Text>
          <TextInput 
            style={styles.input} 
            placeholder="Dán link MangaDex chapter..." 
            placeholderTextColor="#475569"
            value={url}
            onChangeText={setUrl}
            editable={!loading}
            autoCapitalize="none"
            autoCorrect={false}
          />
          
          <TouchableOpacity onPress={handleDownload} disabled={loading || !url}>
            <Animated.View style={[styles.btnGlowWrapper, { borderColor: url && !loading ? glowBorderColor : '#333' }]}>
              <LinearGradient
                colors={loading ? ['#334155', '#1e293b'] : ['#00e5ff', '#0097a7']}
                style={styles.btn}
                start={{x: 0, y: 0}} end={{x: 1, y: 1}}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" style={{marginRight: 10}} />
                ) : (
                  <Feather name="download-cloud" size={20} color="#000" style={{marginRight: 10}} />
                )}
                <Text style={styles.btnText}>{loading ? 'ĐANG KẾT NỐI SERVER...' : 'TẢI & DỊCH'}</Text>
              </LinearGradient>
            </Animated.View>
          </TouchableOpacity>

          {loading && (
            <View style={styles.progressBox}>
              <Text style={styles.statusText}>{status}</Text>
              <View style={styles.barBg}>
                <Animated.View style={[styles.barFill, {width: `${progress * 100}%`}]} />
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>

      <View style={styles.libraryHeader}>
        <Feather name="hard-drive" size={18} color="#94a3b8" style={{marginRight: 8}} />
        <Text style={styles.subtitle}>THƯ VIỆN ĐÃ LƯU ({savedChapters.length})</Text>
      </View>
      
      {savedChapters.length === 0 ? (
        <View style={styles.emptyState}>
          <Feather name="inbox" size={40} color="#334155" />
          <Text style={styles.emptyText}>Chưa có chapter nào được lưu</Text>
        </View>
      ) : (
        <FlatList
          data={savedChapters}
          keyExtractor={item => item}
          style={{width: '100%'}}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{paddingBottom: 40}}
          renderItem={({item}) => (
            <View style={styles.chapCard}>
              <TouchableOpacity style={styles.chapBtn} onPress={() => openChapter(item)}>
                <View style={styles.chapIconWrap}>
                  <Feather name="book-open" size={18} color="#00e5ff" />
                </View>
                <View style={styles.chapInfo}>
                  <Text style={styles.chapText} numberOfLines={1}>{item}</Text>
                  <Text style={styles.chapSub}>MangaDex • Dịch bởi Nexus</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.delBtn} onPress={() => deleteChapter(item)}>
                <Feather name="trash-2" size={18} color="#f43f5e" />
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050505', padding: 20, paddingTop: 60, alignItems: 'center' },
  bgGlow: { position: 'absolute', top: -100, left: -50, width: 300, height: 300, backgroundColor: 'rgba(0, 229, 255, 0.15)', borderRadius: 150, filter: 'blur(50px)' },
  
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 30, width: '100%', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '900', color: '#00e5ff', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', letterSpacing: 2 },
  
  glassPanel: { width: '100%', backgroundColor: 'rgba(15, 23, 42, 0.6)', padding: 20, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', marginBottom: 25 },
  panelTitle: { color: '#94a3b8', fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 12 },
  
  input: { backgroundColor: 'rgba(0,0,0,0.5)', color: '#00e5ff', padding: 16, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(0, 229, 255, 0.3)', marginBottom: 16, fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  
  btnGlowWrapper: { borderRadius: 14, borderWidth: 2, padding: 2 },
  btn: { padding: 16, borderRadius: 10, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  btnText: { color: '#000', fontWeight: '800', fontSize: 15, letterSpacing: 1 },
  
  progressBox: { marginTop: 20, padding: 15, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 10, borderWidth: 1, borderColor: '#00e5ff' },
  statusText: { color: '#00e5ff', fontSize: 12, marginBottom: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', textAlign: 'center' },
  barBg: { width: '100%', height: 4, backgroundColor: '#1e293b', borderRadius: 2, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: '#00e5ff' },
  
  libraryHeader: { flexDirection: 'row', width: '100%', alignItems: 'center', marginBottom: 15, paddingHorizontal: 5 },
  subtitle: { color: '#94a3b8', fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  
  emptyState: { alignItems: 'center', justifyContent: 'center', flex: 1, opacity: 0.5 },
  emptyText: { color: '#94a3b8', marginTop: 15, fontSize: 14 },
  
  chapCard: { flexDirection: 'row', backgroundColor: 'rgba(15, 23, 42, 0.4)', padding: 12, borderRadius: 14, marginBottom: 12, alignItems: 'center', justifyContent: 'space-between', width: '100%', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  chapBtn: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  chapIconWrap: { width: 40, height: 40, borderRadius: 10, backgroundColor: 'rgba(0, 229, 255, 0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  chapInfo: { flex: 1, justifyContent: 'center' },
  chapText: { color: '#e2e8f0', fontSize: 15, fontWeight: '700', marginBottom: 3 },
  chapSub: { color: '#64748b', fontSize: 11 },
  
  delBtn: { padding: 12, backgroundColor: 'rgba(244, 63, 94, 0.1)', borderRadius: 10, marginLeft: 10 },
  
  readerContainer: { flex: 1, backgroundColor: '#000' },
  readerTopBar: { position: 'absolute', top: 0, width: '100%', height: 100, zIndex: 10, flexDirection: 'row', alignItems: 'flex-end', paddingBottom: 15, paddingHorizontal: 15 },
  backBtnReader: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: 8, paddingRight: 15, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(0,229,255,0.3)' },
  backBtnText: { color: '#00e5ff', fontWeight: '700', fontSize: 16, marginLeft: 5 }
});
