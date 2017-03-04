
////////////////////////////////////////////////////////////////////////////////
////////////      EVENT LISTENERS FOR LOCAL STORAGE       //////////////////////
////////////////////////////////////////////////////////////////////////////////
function localStorageSupported() {
 try {
  return "localStorage" in window && window["localStorage"] !== null;
 } catch (e) {
  return false;
 }
}

function saveInstrument(instrumentName) {
  if (!currentState[instrumentName]) {
    console.log('adding value');
    currentState[instrumentName] = [];
  }
  var array = $('#' + instrumentName).children('.cell');
  for (var i = 0; i < array.length; i++) {
    currentState[instrumentName][i] = $(array[i]).hasClass('active');
  }
}

function loadInstrument(instrumentName){
  if (!currentState[instrumentName]) return;
  var array = $('#' + instrumentName).children('.cell');
  for (var i = 0; i < array.length; i++) {
    if (currentState[instrumentName][i]) {
      $(array[i]).addClass('active');
    }
    else {
      $(array[i]).removeClass('active');
    }
  }
}

function saveState(){
  for (var i = 0; i < instruments.length; i++) {
    saveInstrument(instruments[i]);
  }
  console.log(currentState);
  return JSON.stringify(currentState);
}

function loadState(pattern){
  // for pattern
  if (pattern) {
    currentState = JSON.parse(pattern)
  }
  for (var i = 0; i < instruments.length; i++) {
    loadInstrument(instruments[i]);
  }
}

////////////////////////////////////////////////////////////////////////////////
////////////      EVENT LISTENERS FOR BOTTOM PANEL       ///////////////////////
////////////////////////////////////////////////////////////////////////////////
$('#save').click(function(){
  $('#savePanel').show();
  $('#save').addClass('selectedPanel');
  $('#save').removeClass('deselectedPanel');
  $('#loadPanel').hide();
  $('#load').addClass('deselectedPanel');
  $('#load').removeClass('selectedPanel');
  $('#recordPanel').hide();
  $('#record').addClass('deselectedPanel');
  $('#record').removeClass('selectedPanel');
  console.log('save');
});
$('#load').click(function(){
  $('#savePanel').hide();
  $('#save').addClass('deselectedPanel');
  $('#save').removeClass('selectedPanel');
  $('#loadPanel').show();
  $('#load').addClass('selectedPanel');
  $('#load').removeClass('deselectedPanel');
  $('#recordPanel').hide();
  $('#record').addClass('deselectedPanel');
  $('#record').removeClass('selectedPanel');
  console.log('load');
});
$('#record').click(function(){
  $('#savePanel').hide();
  $('#save').addClass('deselectedPanel');
  $('#save').removeClass('selectedPanel');
  $('#loadPanel').hide();
  $('#load').addClass('deselectedPanel');
  $('#load').removeClass('selectedPanel');
  $('#recordPanel').show();
  $('#record').addClass('selectedPanel');
  $('#record').removeClass('deselectedPanel');
  console.log('record');
  // $('#recordStart').click(function(){
    if (!SCConnected) {
      SC.connect().then(function(){
        return SC.get('/me');
      }).then(function(user){
          SCConnected = true;
      })
    }
});

$('#savePattern1').click(function(){
  localStorage.setItem('pattern1', saveState());
});
$('#savePattern2').click(function(){
  localStorage.setItem('pattern2', saveState());
});
$('#savePattern3').click(function(){
  localStorage.setItem('pattern3', saveState());
});
$('#savePattern4').click(function(){
  localStorage.setItem('pattern4', saveState());
});

$('#loadPattern1').click(function(){
  loadState(localStorage.pattern1);
});
$('#loadPattern2').click(function(){
  loadState(localStorage.pattern2);
});
$('#loadPattern3').click(function(){
  loadState(localStorage.pattern3);
});
$('#loadPattern4').click(function(){
  loadState(localStorage.pattern4);
});
